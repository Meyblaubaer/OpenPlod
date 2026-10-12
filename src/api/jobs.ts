import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Job, JobQueue } from '../jobs/queue';

/**
 * Versioned processing-job contract (roadmap KB-06).
 *
 * A stable, read-mostly view over the durable queue in `src/jobs/queue.ts`. It
 * never submits work: jobs are still created by the import, process and
 * forward flows, which keep their own per-recording idempotency. Fields may be
 * added; existing fields keep their meaning within `/api/v1`.
 */
export interface JobDescriptor {
  id: string;
  type: string;
  state: Job['status'];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  recordingId: string | null;
  provider: string | null;
  priority: number;
  checkpoint: { phase: string; remoteId: string | null } | null;
  /** What the job produced. Transcript version ids are only listed once the version exists. */
  resultRefs: { transcriptVersionIds: string[] };
}

const jobListSchema = z.object({
  state: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']).optional(),
  type: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  recordingId: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

const iso = (date: Date | undefined) => date ? date.toISOString() : null;

/**
 * Describe jobs with one SQL statement for the whole page: a processing job
 * saves its transcript version under its own id, so the result refs are the
 * subset of job ids that exist as versions.
 */
export function describeJobs(database: Database, jobs: Job[]): JobDescriptor[] {
  const candidates = jobs.filter(job => job.type === 'process-recording' && job.status === 'complete').map(job => job.id);
  const versions = new Set(candidates.length
    ? (database.query('SELECT id FROM transcript_versions WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(candidates)) as { id: string }[]).map(row => row.id)
    : []);
  return jobs.map(job => {
    const data = (job.data ?? {}) as { recordingId?: unknown; config?: { transcriptionEngine?: unknown } };
    return {
      id: job.id,
      type: job.type,
      state: job.status,
      createdAt: job.createdAt.toISOString(),
      startedAt: iso(job.startedAt),
      completedAt: iso(job.completedAt),
      error: job.error ?? null,
      recordingId: typeof data.recordingId === 'string' ? data.recordingId : null,
      provider: typeof data.config?.transcriptionEngine === 'string' ? data.config.transcriptionEngine : null,
      priority: job.priority,
      checkpoint: job.checkpoint ? { phase: job.checkpoint.phase, remoteId: job.checkpoint.remoteId ?? null } : null,
      resultRefs: { transcriptVersionIds: versions.has(job.id) ? [job.id] : [] },
    };
  });
}

export function createJobsApi(queue: JobQueue, database: Database) {
  const app = new Hono();
  const notFound = { success: false, code: 'job_not_found', error: 'Job not found.' } as const;
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ success: false, code: 'invalid_input', error: error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') }, 400);
    return c.json({ success: false, code: 'jobs_error', error: 'Job status could not be read.' }, 500);
  });
  app.get('/', c => {
    const query = jobListSchema.parse(c.req.query());
    const matching = queue.getAllJobs().filter(job => (!query.state || job.status === query.state) && (!query.type || job.type === query.type)
      && (!query.recordingId || (job.data as { recordingId?: unknown })?.recordingId === query.recordingId));
    // Newest first; the queue holds jobs in submission order.
    const page = matching.slice().reverse().slice(query.offset, query.offset + query.limit);
    return c.json({ success: true, data: { jobs: describeJobs(database, page), total: matching.length, offset: query.offset, limit: query.limit, stats: queue.getStats() } });
  });
  app.get('/:id', c => {
    const job = queue.getJob(c.req.param('id'));
    return job ? c.json({ success: true, data: describeJobs(database, [job])[0] }) : c.json(notFound, 404);
  });
  // Cancels exactly the named job; other jobs, including other work on the same recording, are untouched.
  app.post('/:id/cancel', c => {
    const job = queue.getJob(c.req.param('id'));
    if (!job) return c.json(notFound, 404);
    if (!queue.cancel(job.id)) return c.json({ success: false, code: 'job_not_cancellable', error: `A ${job.status} job cannot be cancelled.` }, 409);
    return c.json({ success: true, data: describeJobs(database, [job])[0] });
  });
  return app;
}

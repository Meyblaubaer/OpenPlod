import type { Database } from 'bun:sqlite';
import type { JobQueue } from '../jobs/queue';
import type { OrganizerStore } from '../organizer/store';
import { DocumentGenerationService } from '../organizer/generation';
import { onAutomationEvent } from './hooks';
import { WebhookService } from './webhooks';
import { RuleEngine } from './rules';
import { TaskService } from './tasks';
import { createAutomationsApi, createWebhooksApi } from './api';

/**
 * Wire webhooks, rules and reviewed tasks into the running server. Called
 * once from `src/index.ts`; nothing in this directory runs until then.
 */
export function startAutomation(params: { database: Database; queue: JobQueue; organizer: OrganizerStore; intervalMs?: number }) {
  const { database, queue, organizer } = params;
  const webhooks = new WebhookService(database);
  const generation = new DocumentGenerationService(organizer);
  const rules = new RuleEngine(database, {
    queue, webhooks,
    generateDocument: async request => {
      await generation.generate(request, async () => {});
      return generation.save(request.idempotencyKey, { folderId: request.folderId }).id;
    },
  });
  const tasks = new TaskService(database);

  // Webhook outbox writes are synchronous so they share the emitter's transaction.
  onAutomationEvent(event => { webhooks.handle(event); });
  onAutomationEvent(async event => {
    if (event.type === 'recording.imported') await rules.onRecordingImported(event.recordingId);
    else if (event.type === 'recording.transcribed') await rules.onRecordingSettled(event.recordingId);
    else if (event.type === 'job.failed' && event.recordingId) await rules.onRecordingSettled(event.recordingId);
  });

  const tick = () => {
    void webhooks.deliverDue().catch(error => console.error('[Webhooks] Delivery worker failed:', error));
    void rules.resumeWaiting().catch(error => console.error('[Automation] Rule sweep failed:', error));
  };
  setInterval(tick, params.intervalMs ?? 15000).unref();
  setTimeout(tick, 1000).unref();

  return { webhooks, rules, tasks, webhooksApi: createWebhooksApi(webhooks), automationsApi: createAutomationsApi(rules, tasks) };
}

import type { Database } from 'bun:sqlite';
import { credential, readAiConfig } from '../ai/config';
import type { CancelHook } from '../jobs/queue';

const remoteId = /^[a-zA-Z0-9-]{1,128}$/;
/**
 * Best-effort AssemblyAI remote cancellation (AI-03). After a local cancel with a
 * known remote job ID, ask AssemblyAI to delete that transcript and report what it
 * answered. A successful deletion is not proof that billing stopped, and the
 * outcome text never claims it did. Only AssemblyAI issues remote IDs here.
 */
export function assemblyAiCancelHook(database: Database, fetcher: typeof fetch = fetch): CancelHook {
  return async job => {
    const id = job.checkpoint?.remoteId;
    if (job.type !== 'process-recording' || !id || (job.checkpoint?.provider ?? 'assemblyai') !== 'assemblyai') return null;
    if (!remoteId.test(id)) return 'Remote deletion was not requested: the stored AssemblyAI job ID is invalid.';
    if (readAiConfig(database).privacyMode === 'local-only') return 'Remote deletion was not requested because local-only mode is on; AssemblyAI may still process and bill this job.';
    const key = credential(database, 'assemblyai');
    if (!key) return 'Remote deletion was not requested because no AssemblyAI key is configured; AssemblyAI may still process and bill this job.';
    try {
      const response = await fetcher(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`, { method: 'DELETE', redirect: 'error', headers: { authorization: key }, signal: AbortSignal.timeout(15000) });
      await response.body?.cancel();
      return response.ok
        ? `AssemblyAI accepted the request to delete remote job ${id}. This does not confirm that billing stopped; audio already processed may be charged.`
        : `AssemblyAI refused to delete remote job ${id} (HTTP ${response.status}). Remote processing may continue and may be billed.`;
    } catch { return `AssemblyAI could not be reached to delete remote job ${id}. Remote processing may continue and may be billed.`; }
  };
}

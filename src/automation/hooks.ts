/**
 * In-process automation events (roadmap KB-08/KB-09).
 *
 * Core modules call `emitAutomationEvent` at a few well-defined points
 * (import, transcription, document creation, job failure). Nothing listens
 * unless `startAutomation` registered a listener, so tests and tools that do
 * not start the server are unaffected. A listener can never break the caller:
 * synchronous throws and rejected promises are swallowed and logged.
 *
 * Events carry identifiers only. Listeners read what they need from the
 * database, so no transcript text travels through this bus.
 */
export type AutomationEvent =
  | { type: 'recording.imported'; recordingId: string }
  | { type: 'recording.transcribed'; recordingId: string; transcriptVersionId: string; provider: string | null; model: string | null; current: boolean }
  | { type: 'document.created'; documentId: string }
  | { type: 'job.failed'; jobId: string; jobType: string; recordingId: string | null; error: string | null };

export type AutomationListener = (event: AutomationEvent) => void | Promise<void>;

const listeners = new Set<AutomationListener>();

export function onAutomationEvent(listener: AutomationListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Deliver an event to every listener. Synchronous listener work (such as an
 * outbox insert) happens before this returns, so it joins the caller's
 * transaction when there is one. Await the result to wait for async work too.
 */
export function emitAutomationEvent(event: AutomationEvent): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const listener of listeners) {
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).then === 'function') pending.push((result as Promise<void>).catch(error => console.error(`[Automation] ${event.type} listener failed:`, error)));
    } catch (error) { console.error(`[Automation] ${event.type} listener failed:`, error); }
  }
  return pending.length ? Promise.all(pending).then(() => undefined) : Promise.resolve();
}

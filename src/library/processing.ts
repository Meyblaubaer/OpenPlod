import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { recordings, userSettings } from '../db/schema';
import { jobQueue } from '../jobs/queue';
import { aiConfigFromSettings } from '../ai/config';
import { emitAutomationEvent } from '../automation/hooks';

export type ProcessingRoute = 'openwhistle' | 'local' | 'disabled';

export async function queueRecordingProcessing(params: {
  recordingId: string;
  filePath: string;
  settings?: Record<string, string>;
}): Promise<ProcessingRoute> {
  // KB-08/KB-09: webhooks and opt-in rules first, so a rule's transcription choice is queued before the default.
  await emitAutomationEvent({ type: 'recording.imported', recordingId: params.recordingId });
  const settings = params.settings ?? Object.fromEntries(
    (await db.select().from(userSettings)).map(setting => [setting.key, setting.value]),
  );

  if (settings.openWhistleForwarding === 'true' && aiConfigFromSettings(settings).privacyMode !== 'local-only') {
    await db.update(recordings).set({ forwardingStatus: 'queued', forwardingError: null })
      .where(eq(recordings.id, params.recordingId));
    await jobQueue.add('forward-recording', { recordingId: params.recordingId });
    return 'openwhistle';
  }

  if (settings.autoTranscribe !== 'false') {
    await jobQueue.add('process-recording', {
      recordingId: params.recordingId,
      filePath: params.filePath,
      config: aiConfigFromSettings(settings),
    });
    return 'local';
  }

  return 'disabled';
}

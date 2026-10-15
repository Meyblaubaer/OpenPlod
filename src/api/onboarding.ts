import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { readAiConfig, readSettings } from '../ai/config';
import { speechCapabilities } from '../ai/capabilities';
import { initializeTranscriptionProfiles } from '../ai/transcription-profiles';
import type { SpeechProvider } from '../ai/config';

export interface OnboardingStatus {
  completedAt: string | null;
  skipped: boolean;
  privacyMode: 'selected-providers' | 'local-only';
  engine: SpeechProvider;
  engineLabel: string;
  /** Whether the selected engine has its key or local binary. Never a live provider call. */
  engineReady: boolean;
  recordings: number;
  documents: number;
  profiles: number;
  defaultProfile: string;
}

const count = (database: Database, sql: string) => {
  try { return (database.query(sql).get() as { n: number }).n; } catch { return 0; }
};

/**
 * First-run setup state. Completion is a single setting so a person can run the guide again
 * from Settings; nothing here changes AI settings, which the guide saves through `/api/ai-settings`.
 */
export function createOnboardingApi(database: Database, engineStatus: () => Partial<Record<SpeechProvider, boolean>>) {
  const app = new Hono();
  const put = (key: string, value: string) => database.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  app.get('/', c => {
    initializeTranscriptionProfiles(database);
    const settings = readSettings(database), config = readAiConfig(database);
    const status: OnboardingStatus = {
      completedAt: settings.onboardingCompletedAt || null,
      skipped: settings.onboardingSkipped === 'true',
      privacyMode: config.privacyMode,
      engine: config.transcriptionEngine,
      engineLabel: speechCapabilities[config.transcriptionEngine].label,
      engineReady: engineStatus()[config.transcriptionEngine] === true,
      recordings: count(database, "SELECT count(*) AS n FROM recordings WHERE retention_state='active'"),
      documents: count(database, 'SELECT count(*) AS n FROM note_documents WHERE deleted_at IS NULL'),
      profiles: count(database, 'SELECT count(*) AS n FROM transcription_profiles'),
      defaultProfile: config.transcriptionProfile,
    };
    return c.json({ success: true, data: status });
  });
  app.post('/complete', async c => {
    const body = z.object({ skipped: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ success: false, error: 'Invalid onboarding request.' }, 400);
    const completedAt = new Date().toISOString();
    database.transaction(() => { put('onboardingCompletedAt', completedAt); put('onboardingSkipped', String(body.data.skipped)); })();
    return c.json({ success: true, data: { completedAt, skipped: body.data.skipped } });
  });
  app.post('/reset', c => {
    database.query("DELETE FROM user_settings WHERE key IN ('onboardingCompletedAt','onboardingSkipped')").run();
    return c.json({ success: true });
  });
  return app;
}

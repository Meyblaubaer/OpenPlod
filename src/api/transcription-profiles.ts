import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { PROFILE_PRESETS, ProfileError, TranscriptionProfiles } from '../ai/transcription-profiles';

/** `/api/v1/transcription-profiles`: named prompts and vocabularies for transcription. */
export function createTranscriptionProfilesApi(database: Database) {
  const profiles = new TranscriptionProfiles(database);
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ success: false, code: 'invalid_input', error: error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ success: false, code: 'invalid_json', error: 'Invalid JSON body.' }, 400);
    if (error instanceof ProfileError) return c.json({ success: false, code: error.status === 404 ? 'not_found' : error.status === 409 ? 'conflict' : 'invalid_input', error: error.message }, error.status);
    return c.json({ success: false, code: 'storage_error', error: 'The profile could not be saved.' }, 500);
  });
  app.get('/', c => c.json({ success: true, data: { profiles: profiles.list(), presets: PROFILE_PRESETS } }));
  app.get('/:id', c => c.json({ success: true, data: profiles.get(c.req.param('id')) }));
  app.post('/', async c => c.json({ success: true, data: profiles.create(await c.req.json()) }, 201));
  app.patch('/:id', async c => c.json({ success: true, data: profiles.update(c.req.param('id'), await c.req.json()) }));
  app.delete('/:id', c => { profiles.delete(c.req.param('id')); return c.json({ success: true }); });
  return app;
}

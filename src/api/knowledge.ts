import { Hono } from 'hono';
import { z } from 'zod';
import { OrganizerError } from '../organizer/store';
import { revisionSchema } from '../organizer/schemas';
import { assertPrivacy, readAiConfig } from '../ai/config';
import type { RecordingCollections } from '../knowledge/collections';
import type { KnowledgeIndex } from '../knowledge/retrieval';
import type { KnowledgeSuggestions } from '../knowledge/suggestions';
import { knowledgeSettingsInput } from '../knowledge/embeddings';

/**
 * Knowledge workspace routes under `/api/v1` (roadmap KB-01, KB-04, KB-05):
 * recording collections, hybrid search and its index settings, recording
 * title/tag suggestions, and recurring-topic summaries.
 */
export function createKnowledgeApi(services: { collections: RecordingCollections; index: KnowledgeIndex; suggestions: KnowledgeSuggestions }) {
  const { collections, index, suggestions } = services;
  const app = new Hono();
  // No '*' middleware here: this app shares the /api/v1 prefix with the organizer API, and a
  // wildcard middleware would also run for its routes. Body size is bounded by the organizer's limit.
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ success: false, code: 'invalid_input', error: error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ success: false, code: 'invalid_json', error: 'Invalid JSON body.' }, 400);
    if (error instanceof OrganizerError) return c.json({ success: false, code: error.code, error: error.message }, error.status);
    return c.json({ success: false, code: 'knowledge_error', error: 'The request could not be completed. Nothing was changed.' }, 500);
  });

  app.get('/collections', c => c.json({ success: true, data: collections.list() }));
  app.post('/collections', async c => c.json({ success: true, data: collections.create(await c.req.json()) }, 201));
  app.get('/collections/:id', c => c.json({ success: true, data: collections.get(c.req.param('id')) }));
  app.patch('/collections/:id', async c => c.json({ success: true, data: collections.update(c.req.param('id'), await c.req.json()) }));
  app.delete('/collections/:id', async c => {
    collections.delete(c.req.param('id'), revisionSchema.parse(await c.req.json()).revision);
    return c.json({ success: true, data: null });
  });
  app.post('/collections/:id/recordings', async c => c.json({ success: true, data: collections.add(c.req.param('id'), await c.req.json()) }));
  app.delete('/collections/:id/recordings', async c => c.json({ success: true, data: collections.remove(c.req.param('id'), await c.req.json()) }));

  app.get('/search', async c => c.json({ success: true, data: await index.search(c.req.query(), { signal: c.req.raw.signal }) }));
  app.get('/search/status', async c => c.json({ success: true, data: await index.status() }));
  app.post('/search/reindex', async c => {
    const options = z.object({ maxSources: z.number().int().min(1).max(500).default(100), rebuild: z.boolean().default(false) }).strict().parse(await c.req.json().catch(() => ({})));
    if (options.rebuild) index.clear();
    return c.json({ success: true, data: await index.refresh({ maxSources: options.maxSources, signal: c.req.raw.signal }) });
  });
  app.put('/search/settings', async c => {
    const { confirmCloud, ...settings } = knowledgeSettingsInput.parse(await c.req.json());
    if (settings.embeddingProvider === 'openai' || settings.embeddingProvider === 'mistral') {
      if (!settings.cloudOptIn || confirmCloud !== true) throw new OrganizerError(400, 'cloud_consent_required', 'Cloud embeddings send every indexed transcript and note passage, and each search query, to the provider. Confirm this explicitly to enable them.');
      try { assertPrivacy(readAiConfig(index.database), settings.embeddingProvider); }
      catch (error) { throw new OrganizerError(400, 'privacy_blocked', (error as Error).message); }
    }
    index.database.query("INSERT INTO user_settings(key,value) VALUES('knowledgeConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(JSON.stringify(settings));
    return c.json({ success: true, data: await index.status() });
  });

  app.post('/recordings/:id/suggestions', async c => c.json({ success: true, data: await suggestions.suggestForRecording(c.req.param('id'), await c.req.json(), c.req.raw.signal) }));
  app.get('/topics', c => c.json({ success: true, data: suggestions.topics(c.req.query()) }));
  app.post('/topics/summary', async c => c.json({ success: true, data: await suggestions.summarizeTopic(await c.req.json(), c.req.raw.signal) }));
  return app;
}

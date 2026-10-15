import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeOrganizer, OrganizerStore } from './store';
import { DocumentSuggestionService, SUGGESTION_INPUT_CHARS } from './suggestions';
import { createOrganizerApi } from '../api/organizer';
import { NoteDeliveryService } from './delivery';
import { DocumentGenerationService } from './generation';
import { MarkdownExporter } from './markdown-export';

let database: Database, store: OrganizerStore;
beforeEach(() => {
  database = new Database(':memory:'); initializeOrganizer(database); store = new OrganizerStore(database);
  database.exec("CREATE TABLE user_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  database.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('mistralApiKey', 'synthetic-key');
});
afterEach(() => database.close());
const reply = (content: string, calls: RequestInit[] = []) => async (_url: string, init: RequestInit) => {
  calls.push(init);
  return Response.json({ model: 'mistral-small-latest', choices: [{ finish_reason: 'stop', message: { content } }] });
};
const note = (input = {}) => store.create({ title: 'Untitled', content: 'We agreed to ship OpenPlod 1.0 on Friday. Remi owns the release notes.', idempotencyKey: crypto.randomUUID(), ...input });

test('suggests a new title and only tags the note does not carry, without changing it', async () => {
  const document = note({ tags: ['Release'] });
  const calls: RequestInit[] = [];
  const service = new DocumentSuggestionService(store, reply('```json\n{"title":"# OpenPlod 1.0 release plan","tags":["#release","Planning","bad,tag","planning"," Shipping "]}\n```', calls));
  const result = await service.suggest(document.id);
  expect(result).toEqual({ documentId: document.id, revision: 1, title: 'OpenPlod 1.0 release plan', tags: ['planning', 'bad tag', 'shipping'], provider: 'mistral', model: 'mistral-small-latest', truncated: false });
  expect(store.get(document.id)).toMatchObject({ title: 'Untitled', revision: 1, tags: ['Release'] });
  const body = JSON.parse(String(calls[0]!.body));
  expect(body.response_format).toEqual({ type: 'json_object' });
  expect(body.messages[0].content).toContain('untrusted data');
  expect(body.messages[1].content).toContain('Current tags: Release');
});

test('long notes are cut and flagged; an unchanged title is not suggested', async () => {
  const document = note({ title: 'Plan', content: 'x'.repeat(SUGGESTION_INPUT_CHARS + 10) });
  const calls: RequestInit[] = [];
  const result = await new DocumentSuggestionService(store, reply('{"title":"Plan","tags":[]}', calls)).suggest(document.id);
  expect(result).toMatchObject({ title: null, tags: [], truncated: true });
  expect(JSON.parse(String(calls[0]!.body)).messages[1].content.length).toBeLessThan(SUGGESTION_INPUT_CHARS + 200);
});

test('refuses Trash, malformed replies, and a missing provider key', async () => {
  const document = note();
  await expect(new DocumentSuggestionService(store, reply('not json')).suggest(document.id)).rejects.toThrow('unexpected format');
  store.trash(document.id, 1);
  await expect(new DocumentSuggestionService(store, reply('{}')).suggest(document.id)).rejects.toThrow('Restore this note');
  database.query("DELETE FROM user_settings").run();
  const saved = process.env.MISTRAL_API_KEY; delete process.env.MISTRAL_API_KEY;
  try {
    const api = createOrganizerApi(store, new NoteDeliveryService(store), new DocumentGenerationService(store), new MarkdownExporter(store, () => null), new DocumentSuggestionService(store, reply('{}')));
    const response = await api.request(`/documents/${note().id}/suggestions`, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('provider_unavailable');
  } finally { if (saved !== undefined) process.env.MISTRAL_API_KEY = saved; }
});

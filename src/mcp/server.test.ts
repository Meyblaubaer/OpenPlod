import { createTranscriptionProfilesApi } from '../api/transcription-profiles';
import { TranscriptionProfiles } from '../ai/transcription-profiles';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeOrganizer, OrganizerStore } from '../organizer/store';
import { createOrganizerApi } from '../api/organizer';
import { createMcpServer, parseScopes, type McpScope, type VaultClient } from './server';
import { OpenPlodClient } from './client';
import { JobQueue } from '../jobs/queue';
import { createJobsApi } from '../api/jobs';

let db: Database, store: OrganizerStore;
beforeEach(() => { db = new Database(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initializeOrganizer(db); store = new OrganizerStore(db); });
afterEach(() => db.close());

async function connect(writable = false) {
  const api = createOrganizerApi(store);
  const vault = new OpenPlodClient('http://127.0.0.1:3499', 'fixture-token', async (url, init) => api.request(new URL(url).pathname.replace('/api/v1', '') + new URL(url).search, init));
  const server = createMcpServer(vault, writable);
  const client = new Client({ name: 'openplod-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('official MCP SDK negotiates read-only tools and Markdown resources', async () => {
  const note = store.create({ title: 'Agent notes', content: '# Read me\n\nUntrusted document text.', idempotencyKey: crypto.randomUUID() });
  const { client, close } = await connect();
  try {
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('list_documents');
    expect(listed.tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    expect(listed.tools.map(tool => tool.name)).not.toContain('create_document');
    const result = await client.callTool({ name: 'get_document', arguments: { id: note.id } });
    expect(JSON.stringify(result.content)).toContain('Untrusted document text');
    expect((await client.listResources()).resources[0].uri).toBe(`openplod://documents/${note.id}`);
    expect((await client.readResource({ uri: `openplod://documents/${note.id}` })).contents[0]).toMatchObject({ mimeType: 'text/markdown', text: note.content });
    const search = await client.callTool({ name: 'list_documents', arguments: { q: 'untrusted' } });
    expect(JSON.stringify(search.content)).toContain('Agent notes');
    const denied = await client.callTool({ name: 'create_document', arguments: { title: 'no', idempotencyKey: crypto.randomUUID() } });
    expect(denied.isError).toBe(true); expect(store.list().total).toBe(1);
  } finally { await close(); }
});

test('write-enabled MCP creates/moves notes, rejects stale revisions and cannot send or purge', async () => {
  const { client, close } = await connect(true);
  try {
    const key = crypto.randomUUID();
    const created = await client.callTool({ name: 'create_document', arguments: { title: 'Created by MCP', content: '# Note', idempotencyKey: key } });
    expect(created.isError).not.toBe(true);
    await client.callTool({ name: 'create_document', arguments: { title: 'Created by MCP', content: '# Note', idempotencyKey: key } });
    expect(store.list().total).toBe(1);
    const note = store.list().documents[0];
    await client.callTool({ name: 'update_document', arguments: { id: note.id, revision: 1, content: 'Edited' } });
    const stale = await client.callTool({ name: 'update_document', arguments: { id: note.id, revision: 1, content: 'Stale' } });
    expect(stale.isError).toBe(true); expect(store.get(note.id).content).toBe('Edited');
    const unconfirmed = await client.callTool({ name: 'trash_document', arguments: { id: note.id, revision: 2 } });
    expect(unconfirmed.isError).toBe(true);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).not.toContain('send_document'); expect(tools).not.toContain('purge_document');
    await client.callTool({ name: 'trash_document', arguments: { id: note.id, revision: 2, confirm: true } });
    expect(store.get(note.id).deletedAt).not.toBeNull();
    await client.callTool({ name: 'restore_document', arguments: { id: note.id, revision: 3 } });
    expect(store.get(note.id).deletedAt).toBeNull();
  } finally { await close(); }
});

test('MCP HTTP client requires credentials and restricts remote transport and API paths', async () => {
  expect(() => new OpenPlodClient('http://example.com', 'secret')).toThrow('HTTPS');
  expect(() => new OpenPlodClient('https://user:pass@example.com', 'secret')).toThrow();
  expect(() => new OpenPlodClient('http://127.0.0.1', '')).toThrow('token');
  let calls = 0;
  const client = new OpenPlodClient('http://localhost:3487', 'secret', async (_url, init) => {
    calls++; expect(init.redirect).toBe('error');
    return Response.json({ error: 'upstream secret value' }, { status: 401 });
  });
  await expect(client.request('/api/settings')).rejects.toThrow('Unsupported');
  await expect(client.request('/api/v1/documents/../../settings')).rejects.toThrow('Unsupported');
  await expect(client.request('/api/v1/documents/%2e%2e/%2e%2e/settings')).rejects.toThrow('Unsupported');
  await expect(client.request('/api/v1/documents')).rejects.toThrow('authorization');
  await expect(client.request('/api/v1/documents?q=version..2')).rejects.toThrow('authorization');
  expect(calls).toBe(2);
  const transportError = new OpenPlodClient('https://vault.example', 'secret', async () => { throw new Error('token=secret'); });
  await expect(transportError.request('/api/v1/documents')).rejects.toThrow('could not be reached');
});

test('read-only MCP exposes source, version, and job tools without any write path (KB-07)', async () => {
  db.exec(`CREATE TABLE recordings (id TEXT PRIMARY KEY, original_filename TEXT, recorded_at TEXT, source_provider TEXT, retention_state TEXT, fingerprint TEXT);
    CREATE TABLE transcripts (recording_id TEXT, current_version_id TEXT, full_text TEXT, origin TEXT);
    CREATE TABLE transcript_versions (id TEXT PRIMARY KEY, recording_id TEXT, full_text TEXT, origin TEXT, provenance TEXT, created_at TEXT);`);
  const recordingId = crypto.randomUUID(), versionId = crypto.randomUUID();
  db.query("INSERT INTO recordings VALUES(?, 'call.m4a', '2026-10-01', 'plaud', 'active', NULL)").run(recordingId);
  db.query("INSERT INTO transcript_versions VALUES(?, ?, 'Version text', 'generated', NULL, '2026-10-01')").run(versionId, recordingId);
  db.query("INSERT INTO transcripts VALUES(?, ?, 'Version text', 'generated')").run(recordingId, versionId);
  const snapshot = store.snapshot({ recordingId, versionId });
  const queue = new JobQueue(db);
  const job = await queue.add('forward-recording', { recordingId });
  let providerCalls = 0;
  queue.register('forward-recording', async () => { providerCalls++; });
  queue.cancel(job.id);

  const jobsApi = createJobsApi(queue, db), organizerApi = createOrganizerApi(store), profilesApi = createTranscriptionProfilesApi(db);
  const methods: string[] = [];
  const vault = new OpenPlodClient('http://127.0.0.1:3499', 'fixture-token', async (url, init) => {
    methods.push(init.method ?? 'GET');
    const { pathname, search } = new URL(url);
    if (pathname.startsWith('/api/v1/transcription-profiles')) return profilesApi.request(pathname.replace('/api/v1/transcription-profiles', '') || '/', init);
    return pathname.startsWith('/api/v1/jobs')
      ? jobsApi.request(pathname.replace('/api/v1/jobs', '') || '/', init)
      : organizerApi.request(pathname.replace('/api/v1', '') + search, init);
  });
  const server = createMcpServer(vault, false);
  const client = new Client({ name: 'openplod-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['list_transcript_versions', 'get_transcript_version', 'list_jobs', 'get_job', 'get_document_source', 'list_transcript_backlinks', 'list_tags', 'list_saved_views', 'get_markdown_export_status', 'list_transcription_profiles'])
      expect(tools.map(tool => tool.name)).toContain(name);
    expect(tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    const text = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
      return { isError: Boolean(response.isError), body: response.content[0]!.text };
    };
    expect(JSON.parse((await text('get_document_source', { id: snapshot.id })).body)).toMatchObject({ status: 'current', stale: false, versionId });
    expect(JSON.parse((await text('list_transcript_versions', { recordingId })).body)).toMatchObject([{ id: versionId, current: true, documentCount: 1 }]);
    expect(JSON.parse((await text('get_transcript_version', { versionId })).body)).toMatchObject({ fullText: 'Version text' });
    expect(JSON.parse((await text('list_transcript_backlinks', { versionId })).body).documents[0].id).toBe(snapshot.id);
    expect(JSON.parse((await text('get_job', { id: job.id })).body)).toMatchObject({ id: job.id, state: 'cancelled', recordingId });
    expect(JSON.parse((await text('list_jobs', { state: 'cancelled' })).body).total).toBe(1);
    const missingJob = await text('get_job', { id: crypto.randomUUID() });
    expect(missingJob).toMatchObject({ isError: true, body: expect.stringContaining('Not found') });
    expect((await text('get_transcript_version', { versionId: crypto.randomUUID() })).isError).toBe(true);
    store.createView({ name: 'Inbox review', filters: { folderId: 'inbox' } });
    expect(JSON.parse((await text('list_saved_views', {})).body)).toMatchObject([{ name: 'Inbox review', filters: { folderId: 'inbox' } }]);
    expect(JSON.parse((await text('get_markdown_export_status', {})).body)).toHaveProperty('configured');
    new TranscriptionProfiles(db).create({ preset: 'medical' });
    const profiles = JSON.parse((await text('list_transcription_profiles', {})).body);
    expect(profiles.profiles).toMatchObject([{ name: 'Medical consultation' }]);
    expect(profiles.presets.length).toBeGreaterThan(3);
    expect(methods.every(method => method === 'GET')).toBe(true);
    expect(providerCalls).toBe(0);
  } finally { await client.close(); await server.close(); }
});

test('OPENPLOD_MCP_SCOPES parses scopes, keeps OPENPLOD_MCP_WRITE compatible, and rejects unknown scopes (KB-07)', () => {
  expect([...parseScopes({})]).toEqual(['read']);
  expect([...parseScopes({ OPENPLOD_MCP_WRITE: '1' })].sort()).toEqual(['read', 'write:documents', 'write:folders']);
  expect([...parseScopes({ OPENPLOD_MCP_SCOPES: 'process, deliver write:documents' })].sort()).toEqual(['deliver', 'process', 'read', 'write:documents']);
  expect(() => parseScopes({ OPENPLOD_MCP_SCOPES: 'read,admin' })).toThrow('Unknown OPENPLOD_MCP_SCOPES entry: admin');
});

async function connectScoped(access: boolean | McpScope[], vault: VaultClient) {
  const server = createMcpServer(vault, access);
  const client = new Client({ name: 'openplod-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(response.isError), body: response.content[0]!.text };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}
const toolNames = async (access: boolean | McpScope[]) => {
  const { client, close } = await connectScoped(access, { request: async () => ({}) });
  try { return (await client.listTools()).tools.map(tool => tool.name); } finally { await close(); }
};

test('each scope registers only its own tools; search and collections are read tools', async () => {
  const readOnly = await toolNames([]);
  for (const name of ['search', 'list_collections', 'get_collection']) expect(readOnly).toContain(name);
  for (const name of ['create_document', 'create_folder', 'start_transcription', 'send_document']) expect(readOnly).not.toContain(name);
  const folders = await toolNames(['write:folders']);
  expect(folders).toContain('create_folder'); expect(folders).not.toContain('create_document');
  const documents = await toolNames(['write:documents']);
  expect(documents).toContain('update_document'); expect(documents).not.toContain('update_folder');
  const processing = await toolNames(['process']);
  expect(processing).toContain('start_transcription'); expect(processing).not.toContain('create_document');
  const deliver = await toolNames(['deliver']);
  expect(deliver).toContain('send_document'); expect(deliver).not.toContain('start_transcription');
  const legacy = await toolNames(true);
  expect(legacy).toContain('create_folder'); expect(legacy).toContain('create_document'); expect(legacy).not.toContain('start_transcription');
  expect(await toolNames(false)).toEqual(readOnly);
});

test('start_transcription requires confirm, reports cloud consent, and passes the idempotency key', async () => {
  const requests: { path: string; method: string; body: any }[] = [];
  let plan: { provider: string; model: string | null; local: boolean; requiresCloudConsent: boolean } = { provider: 'mistral', model: 'voxtral-mini-latest', local: false, requiresCloudConsent: true };
  const vault: VaultClient = { request: async (path, method = 'GET', body) => {
    requests.push({ path, method, body });
    return (body as { dryRun?: boolean })?.dryRun ? { plan, job: null } : { plan, replayed: false, job: { id: 'job-1', state: 'pending' } };
  } };
  const { call, close } = await connectScoped(['process'], vault);
  try {
    const recordingId = crypto.randomUUID();
    expect((await call('start_transcription', { recordingId, idempotencyKey: 'k1' })).isError).toBe(true);
    expect(requests).toEqual([]);
    const refused = await call('start_transcription', { recordingId, confirm: true, idempotencyKey: 'k1' });
    expect(refused.isError).toBe(true);
    expect(refused.body).toContain('mistral');
    expect(refused.body).toContain('acceptCloudProvider');
    expect(requests).toEqual([{ path: '/api/v1/jobs', method: 'POST', body: { type: 'process-recording', recordingId, dryRun: true } }]);
    const started = await call('start_transcription', { recordingId, confirm: true, acceptCloudProvider: true, idempotencyKey: 'k1' });
    expect(JSON.parse(started.body)).toMatchObject({ job: { id: 'job-1' } });
    expect(requests.at(-1)).toEqual({ path: '/api/v1/jobs', method: 'POST', body: { type: 'process-recording', recordingId, confirm: true, acceptCloudProvider: true, idempotencyKey: 'k1' } });
    plan = { provider: 'whisper', model: null, local: true, requiresCloudConsent: false };
    expect((await call('start_transcription', { recordingId, confirm: true, idempotencyKey: 'k2' })).isError).toBe(false);
  } finally { await close(); }
});

test('the MCP client allowlist reaches search and collections but never export settings or reindexing', async () => {
  const seen: string[] = [];
  const client = new OpenPlodClient('http://127.0.0.1:3487', 'secret', async url => { seen.push(new URL(url).pathname); return Response.json({ success: true, data: null }); });
  await client.request('/api/v1/search?q=budget');
  await client.request('/api/v1/collections');
  await client.request(`/api/v1/collections/${crypto.randomUUID()}`);
  await client.request('/api/v1/exports/markdown');
  for (const path of ['/api/v1/exports/markdown/folder', '/api/v1/search/settings', '/api/v1/search/reindex', '/api/ai/ask', '/api/recordings/x/reprocess'])
    await expect(client.request(path, 'PUT', {})).rejects.toThrow('Unsupported');
  expect(seen).toHaveLength(4);
});

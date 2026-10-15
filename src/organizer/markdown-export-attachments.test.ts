import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrganizerStore } from './store';
import { MANIFEST_NAME, MarkdownExporter, EXPORT_DIR_SETTING } from './markdown-export';
import { createOrganizerApi } from '../api/organizer';
import { NoteDeliveryService } from './delivery';
import { DocumentGenerationService } from './generation';
import { addRecording, editTranscript, knowledgeVault } from '../knowledge/fixtures';

let database: Database, store: OrganizerStore, root: string, vault: string, exporter: MarkdownExporter;
beforeEach(() => {
  database = knowledgeVault(); store = new OrganizerStore(database);
  root = mkdtempSync(join(tmpdir(), 'openplod-export-'));
  vault = mkdtempSync(join(tmpdir(), 'openplod-vault-'));
  exporter = new MarkdownExporter(store, () => root);
});
afterEach(() => { database.close(); rmSync(root, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true }); });
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function citedNote() {
  const audio = join(vault, 'meeting.m4a');
  writeFileSync(audio, Buffer.from([0, 1, 2, 3, 250, 251]));
  const recording = addRecording(database, { title: 'Weekly sync', text: 'We keep the audio.', filePath: audio });
  const note = store.snapshot({ recordingId: recording.id, versionId: recording.versionId });
  return { recording, note, audio };
}
const both = { audio: true, transcript: true };

test('attachments copy the audio and the exact cited transcript version, tracked in the manifest (KB-02)', async () => {
  const { recording, note } = citedNote();
  const preview = await exporter.run({ dryRun: true, attachments: both });
  expect(preview.items.filter(item => item.kind === 'attachment').map(item => item.path).sort()).toEqual([`attachments/Weekly sync - transcript ${recording.versionId.slice(0, 8)}.md`, 'attachments/Weekly sync.m4a']);
  expect(existsSync(join(root, 'attachments'))).toBe(false);

  const result = await exporter.run({ confirm: true, attachments: both });
  expect(result.counts).toMatchObject({ created: 3, conflict: 0 });
  expect(readFileSync(join(root, 'attachments/Weekly sync.m4a'))).toEqual(Buffer.from([0, 1, 2, 3, 250, 251]));
  const transcript = read(`attachments/Weekly sync - transcript ${recording.versionId.slice(0, 8)}.md`);
  expect(transcript).toContain(`transcript_version: "${recording.versionId}"`);
  expect(transcript).toEndWith('We keep the audio.\n');
  const noteText = read('Weekly sync.md');
  expect(noteText).toContain(`attachments: ["attachments/Weekly sync.m4a","attachments/Weekly sync - transcript ${recording.versionId.slice(0, 8)}.md"]`);
  const manifest = JSON.parse(read(MANIFEST_NAME));
  expect(manifest.attachments[`audio:${recording.id}`]).toMatchObject({ path: 'attachments/Weekly sync.m4a', sha256: sha(Buffer.from([0, 1, 2, 3, 250, 251])) });
  expect(manifest.attachments[`transcript:${recording.versionId}`].sha256).toBe(sha(transcript));
  expect(manifest.documents[note.id].path).toBe('Weekly sync.md');

  // Idempotent; a newer transcript version does not change what the note cites.
  editTranscript(database, recording.id, 'Edited later.');
  expect((await exporter.run({ confirm: true, attachments: both })).counts).toMatchObject({ unchanged: 3, created: 0, updated: 0 });
  expect((await exporter.status()).attachmentCount).toBe(2);
});

test('an attachment edited outside OpenPlod is a conflict until named in overwriteAttachments', async () => {
  const { recording } = citedNote();
  await exporter.run({ confirm: true, attachments: both });
  const path = `attachments/Weekly sync - transcript ${recording.versionId.slice(0, 8)}.md`;
  writeFileSync(join(root, path), 'my own annotations');
  const blocked = await exporter.run({ confirm: true, attachments: both });
  expect(blocked.items).toContainEqual(expect.objectContaining({ path, action: 'conflict', reason: 'modified_externally', kind: 'attachment', attachmentKey: `transcript:${recording.versionId}` }));
  expect(read(path)).toBe('my own annotations');
  await exporter.run({ confirm: true, attachments: both, overwriteAttachments: [`transcript:${recording.versionId}`] });
  expect(read(path)).toContain('We keep the audio.');
  // A foreign file at an attachment's path is never replaced; the attachment gets a suffix.
  const other = join(vault, 'other.m4a'); writeFileSync(other, 'x');
  const second = addRecording(database, { title: 'Clash', filePath: other });
  writeFileSync(join(root, 'attachments/Clash.m4a'), 'someone else');
  store.snapshot({ recordingId: second.id, versionId: second.versionId });
  await exporter.run({ confirm: true, attachments: { audio: true, transcript: false } });
  expect(read('attachments/Clash.m4a')).toBe('someone else');
  expect(read('attachments/Clash (2).m4a')).toBe('x');
});

test('trashed recordings are not attached and attachments are off by default', async () => {
  const { recording } = citedNote();
  database.query("UPDATE recordings SET retention_state='trash' WHERE id=?").run(recording.id);
  expect((await exporter.run({ confirm: true, attachments: both })).counts.created).toBe(1);
  expect(existsSync(join(root, 'attachments'))).toBe(false);
  expect(read('Weekly sync.md')).not.toContain('attachments:');
});

test('the export folder can be chosen in the app with confirmation, unless the environment locks it', async () => {
  const appExporter = new MarkdownExporter(store, undefined, () => [vault]);
  const previous = process.env.OPENPLOD_EXPORT_DIR;
  delete process.env.OPENPLOD_EXPORT_DIR;
  try {
    expect(await appExporter.status()).toMatchObject({ configured: false, locked: false });
    await expect(appExporter.setFolder({ path: root })).rejects.toThrow();
    await expect(appExporter.setFolder({ path: 'relative/folder', confirm: true })).rejects.toThrow('absolute');
    await expect(appExporter.setFolder({ path: join(root, 'missing'), confirm: true })).rejects.toThrow('existing folder');
    mkdirSync(join(vault, 'inside'));
    await expect(appExporter.setFolder({ path: join(vault, 'inside'), confirm: true })).rejects.toThrow('private vault');
    await expect(appExporter.setFolder({ path: '/', confirm: true })).rejects.toThrow();
    expect(await appExporter.setFolder({ path: root, confirm: true })).toMatchObject({ configured: true, root, source: 'settings', locked: false });
    store.create({ title: 'Chosen folder', content: 'x', idempotencyKey: crypto.randomUUID() });
    expect((await appExporter.run({ confirm: true })).root).toBe(root);
    expect(existsSync(join(root, 'Chosen folder.md'))).toBe(true);

    process.env.OPENPLOD_EXPORT_DIR = vault;
    expect(await appExporter.status()).toMatchObject({ root: vault, source: 'env', locked: true });
    await expect(appExporter.setFolder({ path: root, confirm: true })).rejects.toThrow('OPENPLOD_EXPORT_DIR');
    delete process.env.OPENPLOD_EXPORT_DIR;

    const api = createOrganizerApi(store, new NoteDeliveryService(store), new DocumentGenerationService(store), appExporter);
    const put = (body: unknown) => api.request('/exports/markdown/folder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ path: null })).status).toBe(400);
    expect((await (await put({ path: null, confirm: true })).json()).data).toMatchObject({ configured: false });
    expect(database.query('SELECT value FROM user_settings WHERE key=?').get(EXPORT_DIR_SETTING)).toBeNull();
  } finally { if (previous === undefined) delete process.env.OPENPLOD_EXPORT_DIR; else process.env.OPENPLOD_EXPORT_DIR = previous; }
});

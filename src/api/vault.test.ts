import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultApi } from './vault';

const root = mkdtempSync(join(tmpdir(), 'openplod-vault-api-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function settle(app: ReturnType<typeof createVaultApi>, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { data } = await (await app.request(`/operations/${id}`)).json() as { data: { state: string } & Record<string, unknown> };
    if (data.state !== 'running') return data;
    await Bun.sleep(10);
  }
  throw new Error('operation did not finish');
}

test('backup, verify and restore run as polled operations with validation', async () => {
  const database = new Database(join(root, 'source.db'));
  database.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL); CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const app = createVaultApi(database, { backupsDirectory: join(root, 'backups') });
  expect((await app.request('/backups', { method: 'POST', body: JSON.stringify({ passphrase: 'short' }) })).status).toBe(400);
  expect((await app.request('/backups', { method: 'POST', body: JSON.stringify({ directory: 'relative/path' }) })).status).toBe(400);

  const started = await app.request('/backups', { method: 'POST', body: JSON.stringify({}) });
  expect(started.status).toBe(202);
  const backup = await settle(app, (await started.json() as { data: { id: string } }).data.id) as { state: string; result: { path: string; encrypted: boolean } };
  expect(backup.state).toBe('complete');
  expect(backup.result.encrypted).toBe(false);

  const listed = await (await app.request('/backups')).json() as { data: { files: { name: string }[] } };
  expect(listed.data.files).toHaveLength(1);
  const verify = await app.request('/backups/verify', { method: 'POST', body: JSON.stringify({ path: listed.data.files[0]!.name }) });
  const verified = await settle(app, (await verify.json() as { data: { id: string } }).data.id) as { state: string; result: { databaseIntegrity: string } };
  expect(verified.result.databaseIntegrity).toBe('ok');
  expect((await app.request('/backups/verify', { method: 'POST', body: JSON.stringify({ path: 'missing.tar' }) })).status).toBe(404);

  const restore = await app.request('/restore', { method: 'POST', body: JSON.stringify({ path: backup.result.path, targetDirectory: join(root, 'restored') }) });
  const restored = await settle(app, (await restore.json() as { data: { id: string } }).data.id) as { state: string; result: { databasePath: string } };
  expect(restored.state).toBe('complete');
  const again = await app.request('/restore', { method: 'POST', body: JSON.stringify({ path: backup.result.path, targetDirectory: join(root, 'restored') }) });
  const refused = await settle(app, (await again.json() as { data: { id: string } }).data.id) as { state: string; code: string };
  expect(refused).toMatchObject({ state: 'failed', code: 'target_not_empty' });
  database.close();
});

import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { createBackup, restoreBackup, RestoreTargetNotEmpty, verifyBackup, MIN_PASSPHRASE_LENGTH, type BackupProgress } from '../vault/backup';
import { BackupPassphraseError } from '../vault/backup-crypto';
import { vaultPaths } from '../vault/startup';
import { secretKeyPath } from '../vault/secrets';
import { lastRecoveryReport } from '../library/import-journal';
import { readVaultMeta } from '../db/vault-meta';
import { identityFilePath } from '../sync/plaud-provision';

/**
 * REL-05 endpoints under /api/vault. Backup, verification and restore can take
 * minutes on a large library, so they run as in-process operations that the client
 * polls; the archive itself is never streamed through this API.
 */
type Operation = { id: string; kind: 'backup' | 'verify' | 'restore'; state: 'running' | 'complete' | 'failed';
  startedAt: string; finishedAt?: string; progress?: BackupProgress; result?: unknown; error?: string; code?: string };

const passphrase = z.string().min(MIN_PASSPHRASE_LENGTH).max(1024).optional();
const archivePath = z.string().min(1).max(4096);

export function createVaultApi(database: Database, options: { backupsDirectory?: string } = {}) {
  const app = new Hono();
  const operations = new Map<string, Operation>();
  const backupsDirectory = () => options.backupsDirectory ?? process.env.OPENPLOD_BACKUP_DIR ?? join(vaultPaths().dataDirectory, 'backups');
  let busy = false;

  const run = (kind: Operation['kind'], task: (operation: Operation) => Promise<unknown>) => {
    if (busy) return null;
    busy = true;
    const operation: Operation = { id: crypto.randomUUID(), kind, state: 'running', startedAt: new Date().toISOString() };
    operations.set(operation.id, operation);
    for (const [id, old] of operations) if (operations.size > 20 && old.state !== 'running') operations.delete(id);
    void task(operation).then(result => { operation.state = 'complete'; operation.result = result; })
      .catch(error => {
        operation.state = 'failed';
        operation.error = error instanceof Error ? error.message : 'Operation failed.';
        operation.code = error instanceof BackupPassphraseError ? 'wrong_passphrase' : error instanceof RestoreTargetNotEmpty ? 'target_not_empty' : 'failed';
      })
      .finally(() => { operation.finishedAt = new Date().toISOString(); busy = false; });
    return operation;
  };
  const resolveArchive = (value: string) => {
    const path = isAbsolute(value) ? resolve(value) : join(backupsDirectory(), value);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error('Backup file not found.');
    return path;
  };
  const invalid = (error: z.ZodError) => ({ success: false, error: error.issues[0]?.message ?? 'Invalid request.' });

  app.get('/status', c => {
    const paths = vaultPaths();
    return c.json({ success: true, data: { ...paths, backupsDirectory: backupsDirectory(), meta: readVaultMeta(database),
      tls: Boolean(process.env.OPENPLOD_TLS_CERT), recovery: lastRecoveryReport() } });
  });
  app.get('/recovery', c => c.json({ success: true, data: lastRecoveryReport() }));

  app.get('/backups', c => {
    const directory = backupsDirectory();
    const files = existsSync(directory) ? readdirSync(directory).filter(name => /\.tar(\.opbk)?$/.test(name)).map(name => {
      const info = statSync(join(directory, name));
      return { name, path: join(directory, name), bytes: info.size, modifiedAt: info.mtime.toISOString(), encrypted: name.endsWith('.opbk') };
    }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)) : [];
    return c.json({ success: true, data: { directory, files } });
  });

  app.post('/backups', async c => {
    const input = z.object({ passphrase, directory: z.string().max(4096).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return c.json(invalid(input.error), 400);
    if (input.data.directory && !isAbsolute(input.data.directory)) return c.json({ success: false, error: 'Choose an absolute backup folder.' }, 400);
    const paths = vaultPaths();
    const operation = run('backup', operation => createBackup(
      { database, databasePath: paths.database, library: paths.library, secretKeyPath: secretKeyPath(), deviceIdentityPath: identityFilePath() },
      { outputDirectory: input.data.directory ?? backupsDirectory(), passphrase: input.data.passphrase, onProgress: progress => { operation.progress = progress; } },
    ).then(({ manifest, ...result }) => ({ ...result, counts: manifest.counts, encrypted: manifest.encrypted, skipped: manifest.skipped, credentialsIncluded: manifest.credentialsIncluded })));
    return operation ? c.json({ success: true, data: operation }, 202) : c.json({ success: false, error: 'Another backup or restore is running.' }, 409);
  });

  app.post('/backups/verify', async c => {
    const input = z.object({ path: archivePath, passphrase: z.string().max(1024).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return c.json(invalid(input.error), 400);
    let path: string;
    try { path = resolveArchive(input.data.path); } catch (error) { return c.json({ success: false, error: (error as Error).message }, 404); }
    const operation = run('verify', () => verifyBackup(path, { passphrase: input.data.passphrase })
      .then(result => ({ path, encrypted: result.encrypted, databaseIntegrity: result.databaseIntegrity, createdAt: result.manifest.createdAt,
        appVersion: result.manifest.appVersion, counts: result.manifest.counts, schema: result.manifest.schema, credentialsIncluded: result.manifest.credentialsIncluded })));
    return operation ? c.json({ success: true, data: operation }, 202) : c.json({ success: false, error: 'Another backup or restore is running.' }, 409);
  });

  app.post('/restore', async c => {
    const input = z.object({ path: archivePath, passphrase: z.string().max(1024).optional(), targetDirectory: z.string().min(1).max(4096), confirmOverwrite: z.boolean().optional() })
      .strict().safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return c.json(invalid(input.error), 400);
    if (!isAbsolute(input.data.targetDirectory)) return c.json({ success: false, error: 'Choose an absolute restore folder.' }, 400);
    let path: string;
    try { path = resolveArchive(input.data.path); } catch (error) { return c.json({ success: false, error: (error as Error).message }, 404); }
    const paths = vaultPaths();
    const operation = run('restore', () => restoreBackup(path, { targetDirectory: input.data.targetDirectory, passphrase: input.data.passphrase,
      confirmOverwrite: input.data.confirmOverwrite, liveDirectories: [paths.dataDirectory, paths.library] })
      .then(({ manifest, ...result }) => ({ ...result, counts: manifest.counts })));
    return operation ? c.json({ success: true, data: operation }, 202) : c.json({ success: false, error: 'Another backup or restore is running.' }, 409);
  });

  app.get('/operations/:id', c => {
    const operation = operations.get(c.req.param('id'));
    return operation ? c.json({ success: true, data: operation }) : c.json({ success: false, error: 'Operation not found.' }, 404);
  });
  return app;
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile, constants } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { OrganizerError, OrganizerStore } from './store';
import { markdownExportSchema, exportFolderSchema } from './schemas';
import type { ExportAction, ExportItem, ExportResult, ExportStatus } from './types';

/**
 * Managed one-way Markdown export (roadmap KB-02).
 *
 * Writes every active document into a configured folder (for example an
 * Obsidian vault) and records what it wrote in a manifest. A file is only ever
 * replaced when its bytes still match the manifest; anything changed, deleted,
 * or created by someone else is reported as a conflict and left alone unless the
 * caller names that document in `overwrite`. Files are never deleted, except the
 * previous copy of a moved document whose bytes still match the manifest.
 *
 * Optional attachments copy the cited recording's audio and the exact cited
 * transcript version into `attachments/`, tracked in the same manifest under the
 * same conflict rules (`overwriteAttachments` names the ones that may be replaced).
 */
export const MANIFEST_NAME = '.openplod-export.json';
export const ATTACHMENTS_DIR = 'attachments';
/** The `user_settings` key holding a folder chosen in the app. `OPENPLOD_EXPORT_DIR` always wins. */
export const EXPORT_DIR_SETTING = 'markdownExportDir';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashFile = (path: string) => new Promise<string>((done, reject) => {
  const digest = createHash('sha256');
  createReadStream(path).on('data', chunk => digest.update(chunk)).on('error', reject).on('end', () => done(digest.digest('hex')));
});

const entrySchema = z.object({ path: z.string().min(1).max(1024), base: z.string().min(1).max(1024), revision: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const attachmentKey = z.string().regex(/^(audio|transcript):[0-9a-f-]{36}$/);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  documents: z.record(z.string().uuid(), entrySchema),
  /** Added in 0.7.0; older manifests have none. Keyed by `audio:<recordingId>` or `transcript:<versionId>`. */
  attachments: z.record(attachmentKey, entrySchema.omit({ revision: true })).optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
type Entry = Manifest['documents'][string];
type AttachmentEntry = NonNullable<Manifest['attachments']>[string];

const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** A portable file or folder name: no separators, control or Windows-reserved characters. */
export function safeSegment(value: string, fallback = 'Untitled') {
  let name = value.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*#^[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (name.length > 120) name = name.slice(0, 120).trim();
  if (!name || name === '.' || name === '..' || reserved.test(name)) name = name ? `${name}_` : fallback;
  return name.startsWith('.') ? `_${name}` : name;
}

/** YAML front matter; every string is JSON-quoted, which YAML reads as the same string. */
export function exportedMarkdown(document: { id: string; title: string; content: string; revision: number; updatedAt: string; tags: string[]; properties: Record<string, unknown>; sourceRecordingId: string | null; sourceVersionId: string | null; sourceOrigin: string | null }, attachments: string[] = []) {
  const q = (value: unknown) => JSON.stringify(value ?? null);
  const lines = ['---', `openplod_id: ${q(document.id)}`, `title: ${q(document.title)}`, `revision: ${document.revision}`, `updated: ${q(document.updatedAt)}`,
    `tags: ${q(document.tags)}`];
  if (document.sourceRecordingId) lines.push(`source_recording: ${q(document.sourceRecordingId)}`, `source_version: ${q(document.sourceVersionId)}`, `source_origin: ${q(document.sourceOrigin)}`);
  if (attachments.length) lines.push(`attachments: ${q(attachments)}`);
  if (Object.keys(document.properties).length) lines.push(`properties: ${q(document.properties)}`);
  lines.push('---', '');
  return `${lines.join('\n')}${document.content}${document.content.endsWith('\n') || !document.content ? '' : '\n'}`;
}

export function exportRoot() { return process.env.OPENPLOD_EXPORT_DIR?.trim() || null; }
/** The export folder and where it came from: the environment (locked) or the app's settings. */
export function configuredExportRoot(database: OrganizerStore['database']): { root: string | null; source: 'env' | 'settings' | null } {
  const fromEnv = exportRoot();
  if (fromEnv) return { root: fromEnv, source: 'env' };
  if (!database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").get()) return { root: null, source: null };
  const row = database.query('SELECT value FROM user_settings WHERE key=?').get(EXPORT_DIR_SETTING) as { value: string } | null;
  return row?.value ? { root: row.value, source: 'settings' } : { root: null, source: null };
}
/** Folders the export must never write into: the private vault (database and audio library). */
export function protectedFolders() {
  return [dirname(resolve(process.env.DATABASE_URL || './data/plaud.db')), ...(process.env.OPENPLOD_LIBRARY_PATH ? [resolve(process.env.OPENPLOD_LIBRARY_PATH)] : [])];
}

type Row = { id: string; title: string; content: string; folderId: string | null; revision: number; updatedAt: string; createdAt: string; tags: string; properties: string; sourceRecordingId: string | null; sourceVersionId: string | null; sourceOrigin: string | null };
type AttachmentSource = { key: string; base: string; sha256: string } & ({ kind: 'audio'; file: string } | { kind: 'transcript'; text: string });

export class MarkdownExporter {
  private running = false;
  private readonly root: () => string | null;
  constructor(private readonly store: OrganizerStore, root?: () => string | null, private readonly protectedRoots: () => string[] = protectedFolders) {
    this.root = root ?? (() => configuredExportRoot(store.database).root);
  }

  private source(): ExportStatus['source'] {
    if (exportRoot()) return 'env';
    return configuredExportRoot(this.store.database).source;
  }

  async status(): Promise<ExportStatus> {
    const configured = this.root(), source = this.source(), locked = source === 'env';
    if (!configured) return { configured: false, root: null, source: null, locked, lastExportedAt: null, documentCount: 0, attachmentCount: 0, error: null };
    try {
      const real = await this.resolveRoot(configured);
      const manifest = await this.readManifest(real);
      return { configured: true, root: configured, source, locked, lastExportedAt: manifest?.exportedAt ?? null, documentCount: manifest ? Object.keys(manifest.documents).length : 0, attachmentCount: Object.keys(manifest?.attachments ?? {}).length, error: null };
    } catch (error) {
      return { configured: true, root: configured, source, locked, lastExportedAt: null, documentCount: 0, attachmentCount: 0, error: error instanceof OrganizerError ? error.message : 'Export folder unavailable.' };
    }
  }

  /**
   * Choose the export folder from the app. It must be an existing absolute folder
   * outside the private vault, and the request must carry `confirm: true`. When
   * `OPENPLOD_EXPORT_DIR` is set the folder is locked and cannot be changed here.
   */
  async setFolder(input: unknown): Promise<ExportStatus> {
    const data = exportFolderSchema.parse(input);
    if (exportRoot()) throw new OrganizerError(409, 'export_root_locked', 'The export folder is set by OPENPLOD_EXPORT_DIR and cannot be changed in the app.');
    if (this.running) throw new OrganizerError(409, 'export_running', 'Wait for the current export before changing the folder.');
    const put = this.store.database.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')");
    if (data.path === null) {
      this.store.database.query('DELETE FROM user_settings WHERE key=?').run(EXPORT_DIR_SETTING);
      return this.status();
    }
    const real = await this.resolveRoot(data.path, 400);
    if (dirname(real) === real) throw new OrganizerError(400, 'export_root_invalid', 'Choose a folder, not the root of a drive.');
    for (const folder of this.protectedRoots()) {
      const guarded = await realpath(folder).catch(() => resolve(folder));
      if (real === guarded || real.startsWith(guarded + sep) || guarded.startsWith(real + sep)) throw new OrganizerError(400, 'export_root_protected', "Choose a folder outside OpenPlod's private vault.");
    }
    put.run(EXPORT_DIR_SETTING, resolve(data.path));
    return this.status();
  }

  async run(input: unknown): Promise<ExportResult> {
    const options = markdownExportSchema.parse(input);
    const configured = this.root();
    if (!configured) throw new OrganizerError(503, 'export_not_configured', 'Choose an export folder in the app, or set OPENPLOD_EXPORT_DIR, to enable Markdown export.');
    if (this.running) throw new OrganizerError(409, 'export_running', 'A Markdown export is already running.');
    this.running = true;
    try { return await this.export(configured, options.dryRun, new Set(options.overwrite), options.attachments, new Set(options.overwriteAttachments)); }
    catch (error) {
      if (error instanceof OrganizerError) throw error;
      throw new OrganizerError(503, 'export_failed', 'The export folder could not be written. Files already exported are recorded in the manifest; run the export again.');
    } finally { this.running = false; }
  }

  private async resolveRoot(configured: string, status: 400 | 503 = 503) {
    if (!isAbsolute(configured)) throw new OrganizerError(status, 'export_root_invalid', 'The export folder must be an absolute path.');
    try {
      const real = await realpath(configured);
      if (!(await stat(real)).isDirectory()) throw new Error();
      return real;
    } catch { throw new OrganizerError(status, 'export_root_invalid', 'The export folder must be an existing folder.'); }
  }

  private async readManifest(root: string): Promise<Manifest | null> {
    let text: string;
    try { text = await readFile(join(root, MANIFEST_NAME), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new OrganizerError(503, 'manifest_unreadable', 'The export manifest could not be read.'); }
    try {
      const manifest = manifestSchema.parse(JSON.parse(text));
      for (const entry of [...Object.values(manifest.documents), ...Object.values(manifest.attachments ?? {})]) this.inside(root, entry.path);
      return manifest;
    } catch { throw new OrganizerError(409, 'manifest_invalid', `${MANIFEST_NAME} in the export folder is not a valid OpenPlod manifest. Move it aside to start a new export; existing files are kept.`); }
  }

  /** Resolve a manifest-relative path, refusing anything that leaves the root. */
  private inside(root: string, path: string) {
    const target = join(root, ...path.split('/'));
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || path.includes('\\')) throw new OrganizerError(409, 'manifest_invalid', 'The export manifest names a path outside the export folder.');
    return target;
  }

  /** Hash a file only if it is a regular file; symlinks and folders are never followed or replaced. */
  private async current(target: string): Promise<{ kind: 'missing' } | { kind: 'other' } | { kind: 'file'; sha256: string }> {
    try {
      const info = await lstat(target);
      if (!info.isFile()) return { kind: 'other' };
      return { kind: 'file', sha256: await hashFile(target) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  private folderPaths() {
    const folders = this.store.database.query('SELECT id, name, parent_id AS parentId FROM note_folders').all() as { id: string; name: string; parentId: string | null }[];
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const paths = new Map<string, string[]>();
    const resolvePath = (id: string): string[] => {
      const cached = paths.get(id); if (cached) return cached;
      const segments: string[] = []; const seen = new Set<string>();
      for (let current = byId.get(id); current && !seen.has(current.id) && segments.length < 32; current = current.parentId ? byId.get(current.parentId) : undefined) {
        seen.add(current.id); segments.unshift(safeSegment(current.name, 'Folder'));
      }
      paths.set(id, segments); return segments;
    };
    return (folderId: string | null) => folderId ? resolvePath(folderId) : [];
  }

  private hasTable(name: string) { return Boolean(this.store.database.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); }

  /** What a document's attachment would be, or null when the source is gone, in Trash, or unreadable. */
  private async attachmentSource(kind: 'audio' | 'transcript', recordingId: string, versionId: string | null): Promise<AttachmentSource | null> {
    if (!this.hasTable('recordings')) return null;
    const recording = this.store.database.query("SELECT file_path AS filePath, original_filename AS filename, fingerprint FROM recordings WHERE id=? AND retention_state='active'")
      .get(recordingId) as { filePath: string; filename: string | null; fingerprint: string | null } | null;
    if (!recording) return null;
    const stem = safeSegment((recording.filename ?? '').replace(/\.[^.]+$/, ''), 'Recording');
    if (kind === 'audio') {
      const info = await lstat(recording.filePath).catch(() => null);
      if (!info?.isFile()) return null;
      const extension = (extname(recording.filePath).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) ?? [''])[0];
      // The vault fingerprint is the SHA-256 of the stored file; re-hash only when it is missing.
      const sha256 = /^[0-9a-f]{64}$/.test(recording.fingerprint ?? '') ? recording.fingerprint! : await hashFile(recording.filePath);
      return { kind, key: `audio:${recordingId}`, base: `${ATTACHMENTS_DIR}/${stem}${extension}`, sha256, file: recording.filePath };
    }
    if (!versionId || !this.hasTable('transcript_versions')) return null;
    const version = this.store.database.query('SELECT full_text AS fullText, origin, created_at AS createdAt FROM transcript_versions WHERE id=? AND recording_id=?')
      .get(versionId, recordingId) as { fullText: string; origin: string; createdAt: string } | null;
    if (!version) return null;
    const q = (value: unknown) => JSON.stringify(value ?? null);
    const text = ['---', `openplod_recording: ${q(recordingId)}`, `transcript_version: ${q(versionId)}`, `origin: ${q(version.origin)}`, `created: ${q(version.createdAt)}`, '---', '',
      version.fullText.endsWith('\n') ? version.fullText : `${version.fullText}\n`].join('\n');
    return { kind, key: `transcript:${versionId}`, base: `${ATTACHMENTS_DIR}/${stem} - transcript ${versionId.slice(0, 8)}.md`, sha256: hash(text), text };
  }

  private async export(configured: string, dryRun: boolean, overwrite: Set<string>, attachmentOptions: { audio: boolean; transcript: boolean }, overwriteAttachments: Set<string>): Promise<ExportResult> {
    const root = await this.resolveRoot(configured);
    const previous = await this.readManifest(root);
    const documents: Manifest['documents'] = { ...(previous?.documents ?? {}) };
    const attachments: NonNullable<Manifest['attachments']> = { ...(previous?.attachments ?? {}) };
    const exportedAt = new Date().toISOString();
    const counts: Record<ExportAction, number> = { created: 0, updated: 0, moved: 0, unchanged: 0, conflict: 0, orphaned: 0 };
    const items: ExportItem[] = [];
    const record = (item: ExportItem) => { counts[item.action]++; if (item.action !== 'unchanged') items.push(item); };
    const folderPath = this.folderPaths();

    // Paths owned by the manifest are reserved, compared case-insensitively for macOS and Windows.
    const claimed = new Map<string, string>();
    for (const [id, entry] of Object.entries(documents)) claimed.set(entry.path.toLocaleLowerCase(), id);
    for (const [key, entry] of Object.entries(attachments)) claimed.set(entry.path.toLocaleLowerCase(), key);
    const active = new Set((this.store.database.query('SELECT id FROM note_documents WHERE deleted_at IS NULL').all() as { id: string }[]).map(row => row.id));
    // Oldest first, so the earlier document keeps the unsuffixed name; read in pages to bound memory.
    const page = this.store.database.query(`SELECT d.id, d.title, d.content, d.folder_id AS folderId, d.revision, d.updated_at AS updatedAt, d.created_at AS createdAt,
        (SELECT json_group_array(t.tag) FROM note_tags t WHERE t.document_id=d.id) AS tags, d.properties,
        d.source_recording_id AS sourceRecordingId, d.source_version_id AS sourceVersionId, d.source_origin AS sourceOrigin
      FROM note_documents d WHERE d.deleted_at IS NULL AND (d.created_at, d.id) > (?, ?) ORDER BY d.created_at, d.id LIMIT 100`);
    async function* pages() {
      let cursor: [string, string] = ['', ''];
      while (true) {
        const rows = page.all(...cursor) as Row[];
        yield* rows;
        if (rows.length < 100) return;
        const last = rows[rows.length - 1]; cursor = [last.createdAt, last.id];
      }
    }

    const allocate = async (base: string, id: string) => {
      const extension = extname(base), stem = base.slice(0, base.length - extension.length);
      for (let attempt = 1; attempt < 1000; attempt++) {
        const path = attempt === 1 ? base : `${stem} (${attempt})${extension}`;
        const owner = claimed.get(path.toLocaleLowerCase());
        if (owner && owner !== id) continue;
        if (!owner && (await this.current(this.inside(root, path))).kind !== 'missing') continue;
        return path;
      }
      throw new OrganizerError(409, 'export_collision', 'Too many files share one exported name.');
    };

    // Each attachment is exported once per run, however many notes cite it.
    const handled = new Map<string, string | null>();
    const exportAttachment = async (source: AttachmentSource, documentId: string, title: string): Promise<string | null> => {
      const entry = attachments[source.key] as AttachmentEntry | undefined;
      const item = (path: string, action: ExportAction, reason?: ExportItem['reason']) => record({ documentId, title, path, action, kind: 'attachment', attachmentKey: source.key, ...(reason ? { reason } : {}) });
      const write = (path: string) => source.kind === 'audio' ? this.copy(root, path, source.file) : this.write(root, path, source.text);
      if (entry) {
        const existing = await this.current(this.inside(root, entry.path));
        const pristine = existing.kind === 'file' && (existing.sha256 === entry.sha256 || existing.sha256 === source.sha256);
        if (existing.kind === 'other') { item(entry.path, 'conflict', 'not_a_file'); return entry.path; }
        if (!pristine && !overwriteAttachments.has(source.key)) { item(entry.path, 'conflict', existing.kind === 'missing' ? 'deleted_externally' : 'modified_externally'); return entry.path; }
        const path = entry.base === source.base ? entry.path : await allocate(source.base, source.key);
        if (path === entry.path && existing.kind === 'file' && existing.sha256 === source.sha256) {
          attachments[source.key] = { ...entry, sha256: source.sha256 }; item(path, 'unchanged'); return path;
        }
        if (!dryRun) {
          await write(path);
          if (path !== entry.path && pristine) await rm(this.inside(root, entry.path), { force: true });
        }
        claimed.delete(entry.path.toLocaleLowerCase()); claimed.set(path.toLocaleLowerCase(), source.key);
        attachments[source.key] = { path, base: source.base, sha256: source.sha256 };
        item(path, path === entry.path ? 'updated' : 'moved');
        return path;
      }
      const path = await allocate(source.base, source.key);
      if (!dryRun) await write(path);
      claimed.set(path.toLocaleLowerCase(), source.key);
      attachments[source.key] = { path, base: source.base, sha256: source.sha256 };
      item(path, 'created');
      return path;
    };
    const attachmentsFor = async (row: Row) => {
      if (!row.sourceRecordingId) return [];
      const paths: string[] = [];
      for (const kind of ['audio', 'transcript'] as const) {
        if (!attachmentOptions[kind]) continue;
        const key = kind === 'audio' ? `audio:${row.sourceRecordingId}` : row.sourceVersionId ? `transcript:${row.sourceVersionId}` : null;
        if (!key) continue;
        if (!handled.has(key)) {
          const source = await this.attachmentSource(kind, row.sourceRecordingId, row.sourceVersionId);
          handled.set(key, source ? await exportAttachment(source, row.id, row.title) : null);
        }
        const path = handled.get(key);
        if (path) paths.push(path);
      }
      return paths;
    };

    const saveManifest = () => this.write(root, MANIFEST_NAME, `${JSON.stringify({ schemaVersion: 1, exportedAt, documents, ...(Object.keys(attachments).length ? { attachments } : {}) } satisfies Manifest, null, 2)}\n`);
    try {
      for await (const row of pages()) {
        const document = { ...row, tags: (JSON.parse(row.tags) as string[]).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })), properties: JSON.parse(row.properties) as Record<string, unknown> };
        const text = exportedMarkdown(document, await attachmentsFor(row)), sha256 = hash(text);
        const base = [...folderPath(row.folderId), `${safeSegment(row.title)}.md`].join('/');
        const entry = documents[row.id] as Entry | undefined;
        const forced = overwrite.has(row.id);

        if (entry) {
          const existing = await this.current(this.inside(root, entry.path));
          // Matching the manifest, or already holding exactly the new text, means nobody else's edit is at stake.
          const pristine = existing.kind === 'file' && (existing.sha256 === entry.sha256 || existing.sha256 === sha256);
          if (!pristine && !forced) {
            record({ documentId: row.id, title: row.title, path: entry.path, action: 'conflict', reason: existing.kind === 'missing' ? 'deleted_externally' : existing.kind === 'other' ? 'not_a_file' : 'modified_externally' });
            continue;
          }
          if (existing.kind === 'other') { record({ documentId: row.id, title: row.title, path: entry.path, action: 'conflict', reason: 'not_a_file' }); continue; }
          const path = entry.base === base ? entry.path : await allocate(base, row.id);
          if (path === entry.path && existing.kind === 'file' && existing.sha256 === sha256) {
            documents[row.id] = { ...entry, revision: row.revision, sha256 };
            record({ documentId: row.id, title: row.title, path, action: 'unchanged' }); continue;
          }
          if (!dryRun) {
            await this.write(root, path, text);
            // Remove the earlier copy only when it is still exactly what OpenPlod wrote.
            if (path !== entry.path && pristine) await rm(this.inside(root, entry.path), { force: true });
          }
          claimed.delete(entry.path.toLocaleLowerCase()); claimed.set(path.toLocaleLowerCase(), row.id);
          documents[row.id] = { path, base, revision: row.revision, sha256 };
          record({ documentId: row.id, title: row.title, path, action: path === entry.path ? 'updated' : 'moved' });
          continue;
        }
        const path = await allocate(base, row.id);
        if (!dryRun) await this.write(root, path, text);
        claimed.set(path.toLocaleLowerCase(), row.id);
        documents[row.id] = { path, base, revision: row.revision, sha256 };
        record({ documentId: row.id, title: row.title, path, action: 'created' });
      }
    } catch (error) {
      // Record the files already written so a retry treats them as OpenPlod's own, not as foreign files.
      if (!dryRun) await saveManifest().catch(() => {});
      throw error;
    }
    // Trashed or purged documents keep their exported file and manifest entry.
    for (const [id, entry] of Object.entries(documents)) if (!active.has(id)) record({ documentId: id, title: null, path: entry.path, action: 'orphaned' });
    // Attachments no active note cites any more are kept too; only reported while attachments are exported.
    if (attachmentOptions.audio || attachmentOptions.transcript)
      for (const [key, entry] of Object.entries(attachments)) if (!handled.get(key)) record({ documentId: '', title: null, path: entry.path, action: 'orphaned', kind: 'attachment', attachmentKey: key });

    if (!dryRun) await saveManifest();
    return { root: configured, dryRun, exportedAt, counts, items };
  }

  /** Re-check that the target's folder is inside the root and the target is not a link or folder. */
  private async prepare(root: string, path: string) {
    const target = path === MANIFEST_NAME ? join(root, MANIFEST_NAME) : this.inside(root, path);
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep)) throw new OrganizerError(409, 'export_path_escape', 'An export folder resolves outside the export root.');
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) throw new OrganizerError(409, 'export_path_taken', `${path} is not a regular file.`);
    return target;
  }

  /** Atomic replace through a sibling temporary file. */
  private async write(root: string, path: string, text: string) {
    const target = await this.prepare(root, path);
    const temporary = `${target}.openplod-${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }

  /** Atomic copy of a vault file (audio attachment) through a sibling temporary file. */
  private async copy(root: string, path: string, source: string) {
    const target = await this.prepare(root, path);
    const temporary = `${target}.openplod-${crypto.randomUUID()}.tmp`;
    try { await copyFile(source, temporary, constants.COPYFILE_EXCL); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
}

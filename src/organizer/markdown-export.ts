import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { OrganizerError, OrganizerStore } from './store';
import { markdownExportSchema } from './schemas';
import type { ExportAction, ExportItem, ExportResult, ExportStatus } from './types';

/**
 * Managed one-way Markdown export (roadmap KB-02).
 *
 * Writes every active document into a server-configured folder (for example an
 * Obsidian vault) and records what it wrote in a manifest. A file is only ever
 * replaced when its bytes still match the manifest; anything changed, deleted,
 * or created by someone else is reported as a conflict and left alone unless the
 * caller names that document in `overwrite`. Files are never deleted, except the
 * previous copy of a moved document whose bytes still match the manifest.
 */
export const MANIFEST_NAME = '.openplod-export.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  documents: z.record(z.string().uuid(), z.object({ path: z.string().min(1).max(1024), base: z.string().min(1).max(1024), revision: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
type Manifest = z.infer<typeof manifestSchema>;
type Entry = Manifest['documents'][string];

const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** A portable file or folder name: no separators, control or Windows-reserved characters. */
export function safeSegment(value: string, fallback = 'Untitled') {
  let name = value.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*#^[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (name.length > 120) name = name.slice(0, 120).trim();
  if (!name || name === '.' || name === '..' || reserved.test(name)) name = name ? `${name}_` : fallback;
  return name.startsWith('.') ? `_${name}` : name;
}

/** YAML front matter; every string is JSON-quoted, which YAML reads as the same string. */
export function exportedMarkdown(document: { id: string; title: string; content: string; revision: number; updatedAt: string; tags: string[]; properties: Record<string, unknown>; sourceRecordingId: string | null; sourceVersionId: string | null; sourceOrigin: string | null }) {
  const q = (value: unknown) => JSON.stringify(value ?? null);
  const lines = ['---', `openplod_id: ${q(document.id)}`, `title: ${q(document.title)}`, `revision: ${document.revision}`, `updated: ${q(document.updatedAt)}`,
    `tags: ${q(document.tags)}`];
  if (document.sourceRecordingId) lines.push(`source_recording: ${q(document.sourceRecordingId)}`, `source_version: ${q(document.sourceVersionId)}`, `source_origin: ${q(document.sourceOrigin)}`);
  if (Object.keys(document.properties).length) lines.push(`properties: ${q(document.properties)}`);
  lines.push('---', '');
  return `${lines.join('\n')}${document.content}${document.content.endsWith('\n') || !document.content ? '' : '\n'}`;
}

export function exportRoot() { return process.env.OPENPLOD_EXPORT_DIR?.trim() || null; }

type Row = { id: string; title: string; content: string; folderId: string | null; revision: number; updatedAt: string; createdAt: string; tags: string; properties: string; sourceRecordingId: string | null; sourceVersionId: string | null; sourceOrigin: string | null };

export class MarkdownExporter {
  private running = false;
  constructor(private readonly store: OrganizerStore, private readonly root: () => string | null = exportRoot) {}

  async status(): Promise<ExportStatus> {
    const configured = this.root();
    if (!configured) return { configured: false, root: null, lastExportedAt: null, documentCount: 0, error: null };
    try {
      const real = await this.resolveRoot(configured);
      const manifest = await this.readManifest(real);
      return { configured: true, root: configured, lastExportedAt: manifest?.exportedAt ?? null, documentCount: manifest ? Object.keys(manifest.documents).length : 0, error: null };
    } catch (error) {
      return { configured: true, root: configured, lastExportedAt: null, documentCount: 0, error: error instanceof OrganizerError ? error.message : 'Export folder unavailable.' };
    }
  }

  async run(input: unknown): Promise<ExportResult> {
    const options = markdownExportSchema.parse(input);
    const configured = this.root();
    if (!configured) throw new OrganizerError(503, 'export_not_configured', 'Set OPENPLOD_EXPORT_DIR to an existing folder to enable Markdown export.');
    if (this.running) throw new OrganizerError(409, 'export_running', 'A Markdown export is already running.');
    this.running = true;
    try { return await this.export(configured, options.dryRun, new Set(options.overwrite)); }
    catch (error) {
      if (error instanceof OrganizerError) throw error;
      throw new OrganizerError(503, 'export_failed', 'The export folder could not be written. Files already exported are recorded in the manifest; run the export again.');
    } finally { this.running = false; }
  }

  private async resolveRoot(configured: string) {
    if (!isAbsolute(configured)) throw new OrganizerError(503, 'export_root_invalid', 'OPENPLOD_EXPORT_DIR must be an absolute path.');
    try {
      const real = await realpath(configured);
      if (!(await stat(real)).isDirectory()) throw new Error();
      return real;
    } catch { throw new OrganizerError(503, 'export_root_invalid', 'OPENPLOD_EXPORT_DIR must name an existing folder.'); }
  }

  private async readManifest(root: string): Promise<Manifest | null> {
    let text: string;
    try { text = await readFile(join(root, MANIFEST_NAME), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new OrganizerError(503, 'manifest_unreadable', 'The export manifest could not be read.'); }
    try {
      const manifest = manifestSchema.parse(JSON.parse(text));
      for (const entry of Object.values(manifest.documents)) this.inside(root, entry.path);
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

  /** Read a file only if it is a regular file; symlinks and folders are never followed or replaced. */
  private async current(target: string): Promise<{ kind: 'missing' } | { kind: 'other' } | { kind: 'file'; sha256: string }> {
    try {
      const info = await lstat(target);
      if (!info.isFile()) return { kind: 'other' };
      return { kind: 'file', sha256: hash(await readFile(target, 'utf8')) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  private folderPaths() {
    const folders = this.store.database.query('SELECT id, name, parent_id AS parentId FROM note_folders').all() as { id: string; name: string; parentId: string | null }[];
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const paths = new Map<string, string[]>();
    const resolve = (id: string): string[] => {
      const cached = paths.get(id); if (cached) return cached;
      const segments: string[] = []; const seen = new Set<string>();
      for (let current = byId.get(id); current && !seen.has(current.id) && segments.length < 32; current = current.parentId ? byId.get(current.parentId) : undefined) {
        seen.add(current.id); segments.unshift(safeSegment(current.name, 'Folder'));
      }
      paths.set(id, segments); return segments;
    };
    return (folderId: string | null) => folderId ? resolve(folderId) : [];
  }

  private async export(configured: string, dryRun: boolean, overwrite: Set<string>): Promise<ExportResult> {
    const root = await this.resolveRoot(configured);
    const previous = await this.readManifest(root);
    const documents: Manifest['documents'] = { ...(previous?.documents ?? {}) };
    const exportedAt = new Date().toISOString();
    const counts: Record<ExportAction, number> = { created: 0, updated: 0, moved: 0, unchanged: 0, conflict: 0, orphaned: 0 };
    const items: ExportItem[] = [];
    const record = (item: ExportItem) => { counts[item.action]++; if (item.action !== 'unchanged') items.push(item); };
    const folderPath = this.folderPaths();

    // Paths owned by the manifest are reserved, compared case-insensitively for macOS and Windows.
    const claimed = new Map<string, string>();
    for (const [id, entry] of Object.entries(documents)) claimed.set(entry.path.toLocaleLowerCase(), id);
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
      const extension = '.md', stem = base.slice(0, -extension.length);
      for (let attempt = 1; attempt < 1000; attempt++) {
        const path = attempt === 1 ? base : `${stem} (${attempt})${extension}`;
        const owner = claimed.get(path.toLocaleLowerCase());
        if (owner && owner !== id) continue;
        if (!owner && (await this.current(this.inside(root, path))).kind !== 'missing') continue;
        return path;
      }
      throw new OrganizerError(409, 'export_collision', 'Too many files share one exported name.');
    };

    const saveManifest = () => this.write(root, MANIFEST_NAME, `${JSON.stringify({ schemaVersion: 1, exportedAt, documents } satisfies Manifest, null, 2)}\n`);
    try {
      for await (const row of pages()) {
        const document = { ...row, tags: (JSON.parse(row.tags) as string[]).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })), properties: JSON.parse(row.properties) as Record<string, unknown> };
        const text = exportedMarkdown(document), sha256 = hash(text);
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

    if (!dryRun) await saveManifest();
    return { root: configured, dryRun, exportedAt, counts, items };
  }

  /** Atomic replace through a sibling temporary file, after re-checking the folder is inside the root. */
  private async write(root: string, path: string, text: string) {
    const target = path === MANIFEST_NAME ? join(root, MANIFEST_NAME) : this.inside(root, path);
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep)) throw new OrganizerError(409, 'export_path_escape', 'An export folder resolves outside the export root.');
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) throw new OrganizerError(409, 'export_path_taken', `${path} is not a regular file.`);
    const temporary = `${target}.openplod-${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
}

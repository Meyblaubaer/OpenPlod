import { z } from 'zod';

export const identifier = z.string().uuid();
export const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const noteTitle = z.string().trim().min(1).max(180).refine(value => !/[\x00-\x1f/\\]/.test(value), 'Use a title without path separators or control characters');
export const markdown = z.string().max(524288).refine(value => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 524288, 'Markdown must be UTF-8 text up to 512 KB');
/** Freeform tags: trimmed for display, compared case-insensitively. */
export const noteTag = z.string().trim().min(1).max(64).refine(value => !/[\x00-\x1f,]/.test(value), 'Use a tag without commas or control characters');
export const noteTags = z.array(noteTag).max(32);
const propertyKey = z.string().trim().min(1).max(64).refine(value => !/[\x00-\x1f]/.test(value), 'Use a property name without control characters');
/** Schemaless properties; values are stored verbatim. Updates merge by key, and `null` removes a key. */
export const noteProperties = z.record(propertyKey, z.json())
  .refine(value => Object.keys(value).length <= 64, 'Documents support up to 64 properties')
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16384, 'Properties must fit in 16 KB');
export const createFolderSchema = z.object({ name: noteTitle, parentId: identifier.nullable().default(null) }).strict();
export const updateFolderSchema = z.object({ name: noteTitle.optional(), parentId: identifier.nullable().optional(), revision }).strict();
export const createNoteSchema = z.object({ title: noteTitle, content: markdown.default(''), folderId: identifier.nullable().default(null), tags: noteTags.default([]), properties: noteProperties.default({}), idempotencyKey: identifier }).strict();
export const updateNoteSchema = z.object({ title: noteTitle.optional(), content: markdown.optional(), folderId: identifier.nullable().optional(), starred: z.boolean().optional(), tags: noteTags.optional(), properties: noteProperties.optional(), revision }).strict();
export const snapshotSchema = z.object({ recordingId: identifier, versionId: identifier.nullable().optional(), folderId: identifier.nullable().default(null), title: noteTitle.optional() }).strict();
export const noteListSchema = z.object({
  folderId: z.union([identifier, z.literal('inbox')]).optional(),
  view: z.enum(['all', 'starred', 'trash']).default('all'), q: z.string().trim().max(200).default(''),
  sort: z.enum(['updated', 'title']).default('updated'), tag: noteTag.optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export const revisionSchema = z.object({ revision }).strict();
export const purgeSchema = z.object({ revision, confirm: z.literal(true) }).strict();
export const sendNoteSchema = z.object({ destinationId: z.string().regex(/^[a-z0-9-]{1,64}$/), revision, confirm: z.literal(true), idempotencyKey: identifier }).strict();
/** A saved view stores list filters only; pagination is never saved. */
export const savedViewFilters = noteListSchema.pick({ folderId: true, view: true, q: true, sort: true, tag: true }).strict();
const viewName = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f]/.test(value), 'Use a view name without control characters');
export const createViewSchema = z.object({ name: viewName, filters: savedViewFilters }).strict();
export const updateViewSchema = z.object({ name: viewName.optional(), filters: savedViewFilters.optional(), revision }).strict();
export const markdownExportSchema = z.object({
  dryRun: z.boolean().default(false),
  /** Documents whose exported file may be replaced or recreated despite an external change. */
  overwrite: z.array(identifier).max(1000).default([]),
  confirm: z.literal(true).optional(),
}).strict().refine(value => value.dryRun || value.confirm === true, { message: 'Confirm the export, or request a dry run first', path: ['confirm'] });

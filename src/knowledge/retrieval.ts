import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { blobToVector, cosine, readKnowledgeSettings, resolveEmbedder, vectorToBlob, type EmbeddingProvider, type Fetcher } from './embeddings';
import { ftsOrQuery } from './text';
import type { EmbeddingInfo, IndexStatus, Retriever, SearchPassage, SearchResult } from './types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const segmentSchema = z.array(z.object({ text: z.string(), start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative() }).passthrough());

export interface Chunk { seq: number; text: string; segmentStart: number | null; segmentEnd: number | null; startTime: number | null; endTime: number | null }
/** Passage size: long enough to carry an idea, short enough to cite precisely. */
export const PASSAGE_TARGET_CHARS = 700;
export const PASSAGE_MAX_CHARS = 1400;
/** Each retriever contributes this many candidates before fusion. */
const CANDIDATES = 50;
/** Hybrid score = FTS_WEIGHT * normalized bm25 + (1 - FTS_WEIGHT) * cosine. */
export const FTS_WEIGHT = 0.5;

const normalizeSpace = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Cut a transcript version into passages. When the stored segments cover the
 * whole text, passages are runs of whole segments and carry the segment index
 * range and the start/end times from those segments. Otherwise the text is cut
 * at paragraph breaks and no time is attached: a timestamp is never estimated.
 */
export function chunkTranscript(fullText: string, segmentsJson: string | null): Chunk[] {
  let segments: z.infer<typeof segmentSchema> = [];
  try { const parsed = segmentSchema.safeParse(segmentsJson ? JSON.parse(segmentsJson) : []); if (parsed.success) segments = parsed.data; } catch { segments = []; }
  const complete = segments.length > 0 && normalizeSpace(segments.map(segment => segment.text).join(' ')) === normalizeSpace(fullText);
  if (!complete) return chunkText(fullText);
  const chunks: Chunk[] = [];
  let first = 0, parts: string[] = [], length = 0;
  const flush = (last: number) => {
    const text = parts.join(' ').trim();
    if (text) chunks.push({ seq: chunks.length, text, segmentStart: first, segmentEnd: last, startTime: segments[first].start, endTime: segments[last].end });
    parts = []; length = 0; first = last + 1;
  };
  segments.forEach((segment, index) => {
    const text = segment.text.trim();
    if (length && length + text.length + 1 > PASSAGE_MAX_CHARS) flush(index - 1);
    if (!parts.length) first = index;
    parts.push(text); length += text.length + 1;
    if (length >= PASSAGE_TARGET_CHARS) flush(index);
  });
  if (parts.length) flush(segments.length - 1);
  return chunks;
}

/** Paragraph-based passages for text without segments; long paragraphs are cut at sentence ends. */
export function chunkText(text: string): Chunk[] {
  const pieces: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean)) {
    if (paragraph.length <= PASSAGE_MAX_CHARS) { pieces.push(paragraph); continue; }
    let rest = paragraph;
    while (rest.length > PASSAGE_MAX_CHARS) {
      const window = rest.slice(0, PASSAGE_MAX_CHARS);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('\n'));
      const at = cut > PASSAGE_TARGET_CHARS / 2 ? cut + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : PASSAGE_MAX_CHARS;
      pieces.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: Chunk[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > PASSAGE_MAX_CHARS) { chunks.push(plain(chunks.length, current)); current = ''; }
    current = current ? `${current}\n\n${piece}` : piece;
    if (current.length >= PASSAGE_TARGET_CHARS) { chunks.push(plain(chunks.length, current)); current = ''; }
  }
  if (current) chunks.push(plain(chunks.length, current));
  return chunks;
}
const plain = (seq: number, text: string): Chunk => ({ seq, text, segmentStart: null, segmentEnd: null, startTime: null, endTime: null });

type Source =
  | { key: string; type: 'transcript'; recordingId: string; versionId: string | null; fullText: string; segments: string | null }
  | { key: string; type: 'document'; documentId: string; revision: number; title: string; content: string };
const sourceHash = (source: Source) => source.type === 'transcript'
  ? hash(`transcript\0${source.versionId ?? ''}\0${source.fullText}\0${source.segments ?? ''}`)
  : hash(`document\0${source.revision}\0${source.title}\0${source.content}`);

export const searchInputSchema = z.object({
  q: z.string().trim().min(2).max(500),
  mode: z.enum(['hybrid', 'lexical', 'semantic']).default('hybrid'),
  source: z.enum(['all', 'transcripts', 'documents']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

/**
 * Hybrid retrieval over transcripts and documents (roadmap KB-04).
 *
 * Only the current transcript version of active recordings and active documents
 * are indexed. Every query re-checks that a passage still belongs to the current
 * version of an active source, on top of the triggers in `schema.ts` that delete
 * cached passages and vectors on Trash, purge, or a new version.
 */
export class KnowledgeIndex {
  private refreshing: Promise<unknown> | null = null;
  constructor(readonly database: Database, private readonly fetcher: Fetcher = fetch,
    private readonly embedder: () => Promise<{ provider: EmbeddingProvider; info: EmbeddingInfo }> = () => resolveEmbedder(database, fetcher)) {}

  private hasDocuments() { return Boolean(this.database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='note_documents'").get()); }

  /** SQL that keeps a passage `p` only while its source is active and current. */
  private activeFilter(source: 'all' | 'transcripts' | 'documents' = 'all') {
    const transcript = `(p.source_type='transcript' AND EXISTS (SELECT 1 FROM recordings r JOIN transcripts t ON t.recording_id=r.id
      WHERE r.id=p.recording_id AND r.retention_state='active' AND t.current_version_id IS p.version_id))`;
    const document = this.hasDocuments() ? `(p.source_type='document' AND EXISTS (SELECT 1 FROM note_documents d WHERE d.id=p.document_id AND d.deleted_at IS NULL AND d.revision=p.document_revision))` : '0';
    return source === 'transcripts' ? transcript : source === 'documents' ? document : `(${transcript} OR ${document})`;
  }

  private pendingSources(model: string, limit: number): Source[] {
    const transcripts = this.database.query(`SELECT r.id AS recordingId, t.current_version_id AS versionId, t.full_text AS fullText, t.segments
      FROM recordings r JOIN transcripts t ON t.recording_id=r.id
      WHERE r.retention_state='active' AND trim(t.full_text)<>'' AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.source_key='t:' || r.id AND s.model=?)
      ORDER BY r.rowid DESC LIMIT ?`).all(model, limit) as { recordingId: string; versionId: string | null; fullText: string; segments: string | null }[];
    const sources: Source[] = transcripts.map(row => ({ key: `t:${row.recordingId}`, type: 'transcript', ...row }));
    if (sources.length < limit && this.hasDocuments()) {
      const documents = this.database.query(`SELECT d.id AS documentId, d.revision, d.title, d.content FROM note_documents d
        WHERE d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.source_key='d:' || d.id AND s.model=?)
        ORDER BY d.updated_at DESC LIMIT ?`).all(model, limit - sources.length) as { documentId: string; revision: number; title: string; content: string }[];
      sources.push(...documents.map(row => ({ key: `d:${row.documentId}`, type: 'document' as const, ...row })));
    }
    return sources;
  }

  private pendingCount(model: string) {
    const transcripts = (this.database.query(`SELECT count(*) AS count FROM recordings r JOIN transcripts t ON t.recording_id=r.id
      WHERE r.retention_state='active' AND trim(t.full_text)<>'' AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.source_key='t:' || r.id AND s.model=?)`).get(model) as { count: number }).count;
    const documents = this.hasDocuments() ? (this.database.query(`SELECT count(*) AS count FROM note_documents d
      WHERE d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.source_key='d:' || d.id AND s.model=?)`).get(model) as { count: number }).count : 0;
    return transcripts + documents;
  }

  /** Re-read a source inside a transaction; null when it is gone, trashed, or changed. */
  private currentSource(key: string): Source | null {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    if (kind === 't') {
      const row = this.database.query(`SELECT r.id AS recordingId, t.current_version_id AS versionId, t.full_text AS fullText, t.segments FROM recordings r JOIN transcripts t ON t.recording_id=r.id
        WHERE r.id=? AND r.retention_state='active'`).get(id) as { recordingId: string; versionId: string | null; fullText: string; segments: string | null } | null;
      return row ? { key, type: 'transcript', ...row } : null;
    }
    if (!this.hasDocuments()) return null;
    const row = this.database.query('SELECT id AS documentId, revision, title, content FROM note_documents WHERE id=? AND deleted_at IS NULL').get(id) as { documentId: string; revision: number; title: string; content: string } | null;
    return row ? { key, type: 'document', ...row } : null;
  }

  private writePassages(source: Source, digest: string) {
    this.database.query('DELETE FROM knowledge_passages WHERE source_key=?').run(source.key);
    this.database.query('DELETE FROM knowledge_sources WHERE source_key=?').run(source.key);
    const chunks = source.type === 'transcript' ? chunkTranscript(source.fullText, source.segments) : chunkText(`${source.title}\n\n${source.content}`);
    const insert = this.database.query(`INSERT INTO knowledge_passages(id, source_type, source_key, recording_id, version_id, document_id, document_revision, seq,
      segment_start, segment_end, start_time, end_time, text, source_hash, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    for (const chunk of chunks) insert.run(crypto.randomUUID(), source.type, source.key,
      source.type === 'transcript' ? source.recordingId : null, source.type === 'transcript' ? source.versionId : null,
      source.type === 'document' ? source.documentId : null, source.type === 'document' ? source.revision : null,
      chunk.seq, chunk.segmentStart, chunk.segmentEnd, chunk.startTime, chunk.endTime, chunk.text, digest, now);
  }

  /**
   * Index up to `maxSources` sources that have no vectors for the current model.
   * Passages are shared between models; only missing vectors are computed.
   */
  async refresh(options: { maxSources?: number; signal?: AbortSignal } = {}): Promise<{ indexed: number; pending: number; embedding: EmbeddingInfo }> {
    // One refresh at a time; a concurrent caller waits for it instead of embedding twice.
    while (this.refreshing) await this.refreshing.catch(() => {});
    const run = this.refreshOnce(options.maxSources ?? 50, options.signal);
    this.refreshing = run;
    try { return await run; } finally { this.refreshing = null; }
  }

  private async refreshOnce(maxSources: number, signal?: AbortSignal) {
    const { provider, info } = await this.embedder();
    let indexed = 0;
    for (const source of this.pendingSources(provider.model, maxSources)) {
      signal?.throwIfAborted();
      const digest = sourceHash(source);
      const passages = this.database.transaction(() => {
        const existing = this.database.query('SELECT source_hash AS hash FROM knowledge_passages WHERE source_key=? LIMIT 1').get(source.key) as { hash: string } | null;
        if (!existing || existing.hash !== digest) this.writePassages(source, digest);
        return this.database.query(`SELECT p.id, p.text FROM knowledge_passages p WHERE p.source_key=? AND NOT EXISTS (SELECT 1 FROM knowledge_vectors v WHERE v.passage_id=p.id AND v.model=?) ORDER BY p.seq`)
          .all(source.key, provider.model) as { id: string; text: string }[];
      })();
      const vectors = passages.length ? await provider.embed(passages.map(passage => passage.text), { purpose: 'document', signal }) : [];
      this.database.transaction(() => {
        // The source may have changed while it was being embedded; then its passages are already gone.
        const current = this.currentSource(source.key);
        if (!current || sourceHash(current) !== digest) return;
        const insert = this.database.query('INSERT OR REPLACE INTO knowledge_vectors(passage_id, model, dims, vector) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM knowledge_passages WHERE id=? AND source_hash=?)');
        passages.forEach((passage, index) => insert.run(passage.id, provider.model, vectors[index].length, vectorToBlob(vectors[index]), passage.id, digest));
        this.database.query('INSERT OR REPLACE INTO knowledge_sources(source_key, model, source_hash, indexed_at) VALUES(?,?,?,?)').run(source.key, provider.model, digest, new Date().toISOString());
        indexed++;
      })();
    }
    return { indexed, pending: this.pendingCount(provider.model), embedding: info };
  }

  /** Remove every cached passage and vector (the index is rebuilt on the next search). */
  clear() {
    this.database.transaction(() => { this.database.exec('DELETE FROM knowledge_passages; DELETE FROM knowledge_vectors; DELETE FROM knowledge_sources; DELETE FROM knowledge_fts;'); })();
  }

  async status(): Promise<IndexStatus> {
    const { provider, info } = await this.embedder();
    return { settings: readKnowledgeSettings(this.database), embedding: info, ...this.counts(provider.model) };
  }

  private counts(model: string) {
    const sources = (this.database.query('SELECT count(*) AS count FROM knowledge_sources WHERE model=?').get(model) as { count: number }).count;
    const passages = (this.database.query('SELECT count(*) AS count FROM knowledge_vectors WHERE model=?').get(model) as { count: number }).count;
    return { sources, passages, pending: this.pendingCount(model) };
  }

  private idf() {
    const total = (this.database.query('SELECT count(*) AS count FROM knowledge_passages').get() as { count: number }).count;
    const lookup = this.database.query('SELECT doc FROM knowledge_fts_vocab WHERE term=?');
    return (token: string) => {
      const df = (lookup.get(token) as { doc: number } | null)?.doc ?? 0;
      return Math.log((total + 1) / (df + 0.5)) + 1;
    };
  }

  /**
   * Hybrid search. Up to 50 candidates come from FTS5 bm25 and up to 50 from
   * cosine similarity over the stored vectors of the current model. Scores are
   * fused as FTS_WEIGHT * (bm25 / best bm25) + (1 - FTS_WEIGHT) * max(0, cosine);
   * `lexical` and `semantic` modes use one retriever only.
   */
  async search(input: unknown, options: { recordingIds?: string[]; signal?: AbortSignal; refresh?: boolean } = {}): Promise<SearchResult> {
    const data = searchInputSchema.parse(input);
    let refreshNote: string | null = null;
    if (options.refresh !== false) {
      try { await this.refresh({ maxSources: 25, signal: options.signal }); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        refreshNote = 'Some sources could not be indexed yet; results cover what is already indexed.';
      }
    }
    const { provider, info } = await this.embedder();
    const filter = this.activeFilter(data.source);
    const scope = options.recordingIds ? ' AND p.recording_id IN (SELECT value FROM json_each(?))' : '';
    const scopeArgs = options.recordingIds ? [JSON.stringify(options.recordingIds)] : [];

    const fts = new Map<string, number>();
    const query = ftsOrQuery(data.q);
    if (data.mode !== 'semantic' && query) {
      const rows = this.database.query(`SELECT p.id, bm25(knowledge_fts) AS rank FROM knowledge_fts JOIN knowledge_passages p ON p.id=knowledge_fts.passage_id
        WHERE knowledge_fts MATCH ? AND ${filter}${scope} ORDER BY rank LIMIT ${CANDIDATES}`).all(query, ...scopeArgs) as { id: string; rank: number }[];
      const best = Math.max(...rows.map(row => -row.rank), 0);
      for (const row of rows) fts.set(row.id, best > 0 ? -row.rank / best : 0);
    }
    const vector = new Map<string, number>();
    // The lexical fallback has no notion of meaning: a hashed-vector match without a shared
    // word is a hash collision, so its candidates are limited to passages sharing a word.
    const lexicalGate = info.kind === 'lexical';
    if (data.mode !== 'lexical' && (!lexicalGate || query)) {
      const [queryVector] = await provider.embed([data.q], { purpose: 'query', signal: options.signal, idf: this.idf() });
      const gate = lexicalGate ? ' AND p.id IN (SELECT passage_id FROM knowledge_fts WHERE knowledge_fts MATCH ? LIMIT 2000)' : '';
      const rows = this.database.query(`SELECT v.passage_id AS id, v.vector FROM knowledge_vectors v JOIN knowledge_passages p ON p.id=v.passage_id
        WHERE v.model=? AND ${filter}${scope}${gate}`).all(provider.model, ...scopeArgs, ...(lexicalGate ? [query] : [])) as { id: string; vector: Uint8Array }[];
      const scored = rows.map(row => ({ id: row.id, score: cosine(queryVector, blobToVector(row.vector)) })).filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score).slice(0, CANDIDATES);
      for (const row of scored) vector.set(row.id, row.score);
    }
    const weight = data.mode === 'lexical' ? 1 : data.mode === 'semantic' ? 0 : FTS_WEIGHT;
    const ranked = [...new Set([...fts.keys(), ...vector.keys()])].map(id => {
      const scores = { fts: fts.get(id) ?? 0, vector: vector.get(id) ?? 0 };
      return { id, scores, score: weight * scores.fts + (1 - weight) * scores.vector, matchedBy: [...(fts.has(id) ? ['fts'] : []), ...(vector.has(id) ? ['vector'] : [])] as Retriever[] };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, data.limit);
    const details = this.passages(ranked.map(row => row.id));
    const passages = ranked.flatMap(row => { const detail = details.get(row.id); return detail ? [{ ...detail, score: Number(row.score.toFixed(6)), scores: { fts: Number(row.scores.fts.toFixed(6)), vector: Number(row.scores.vector.toFixed(6)) }, matchedBy: row.matchedBy }] : []; });
    return { query: data.q, mode: data.mode, embedding: refreshNote ? { ...info, note: info.note ? `${info.note} ${refreshNote}` : refreshNote } : info, passages, index: this.counts(provider.model) };
  }

  private passages(ids: string[]) {
    const documents = this.hasDocuments();
    const rows = ids.length ? this.database.query(`SELECT p.id, p.source_type AS sourceType, p.recording_id AS recordingId, r.original_filename AS recordingTitle, p.version_id AS versionId,
        p.document_id AS documentId, ${documents ? '(SELECT title FROM note_documents d WHERE d.id=p.document_id)' : 'NULL'} AS documentTitle,
        p.segment_start AS segmentStart, p.segment_end AS segmentEnd, p.start_time AS startTime, p.end_time AS endTime, p.text
      FROM knowledge_passages p LEFT JOIN recordings r ON r.id=p.recording_id WHERE p.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Omit<SearchPassage, 'score' | 'scores' | 'matchedBy'>[] : [];
    return new Map(rows.map(row => [row.id, row]));
  }
}

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { TranscriptStructure } from './transcript-ai';

/**
 * Saved transcript structure (roadmap TS-06).
 *
 * Extraction is a paid AI call, so its result is worth keeping, but it is
 * still a *proposal* until a person saves it. The flow is:
 *
 *  1. `propose` holds the server's own extraction in memory under a one-time
 *     ID. The client only ever gets that ID back to save; it cannot submit a
 *     structure of its own, so every saved timestamp is one this server
 *     resolved from its stored segments, never one a client or model invented.
 *  2. `save` writes that proposal as a new row tied to the transcript version
 *     it was extracted from. Regenerating never overwrites: each save is a new
 *     row, and history is kept until someone deletes a row explicitly.
 *
 * A row is "current" when its version is still the transcript's current
 * version. A stale row is kept and labelled, not hidden or silently re-run.
 */

export interface SavedStructure {
  id: string;
  recordingId: string;
  /** The transcript version it was extracted from; null for a legacy unversioned transcript. */
  versionId: string | null;
  sourceHash: string;
  structure: TranscriptStructure;
  provider: string;
  model: string;
  createdAt: string;
  /** True while that version is still the recording's current transcript. */
  current: boolean;
}

export interface StructureProposal {
  proposalId: string;
  recordingId: string;
  versionId: string | null;
  sourceHash: string;
  structure: TranscriptStructure;
  createdAt: number;
}

export class StructureStoreError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) { super(message); }
}

const PROPOSAL_TTL_MS = 3_600_000;
const MAX_PROPOSALS = 100;
export const structureSourceHash = (text: string) => createHash('sha256').update(text).digest('hex');

type Row = {
  id: string; recordingId: string; versionId: string | null; sourceHash: string; structure: string;
  provider: string; model: string; createdAt: string;
};

export class StructureStore {
  private proposals = new Map<string, StructureProposal>();

  constructor(private readonly database: Database, private readonly now: () => number = Date.now) {
    // Additive and idempotent: safe to run on every start and on any vault age.
    database.exec(`CREATE TABLE IF NOT EXISTS transcript_structures (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      version_id TEXT,
      source_hash TEXT NOT NULL,
      structure TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_structures_recording ON transcript_structures(recording_id, created_at DESC)`);
  }

  /** Hold an extraction for review. Nothing is written to the vault. */
  propose(input: Omit<StructureProposal, 'proposalId' | 'createdAt'>): StructureProposal {
    this.prune();
    // Bound memory if proposals are generated and never saved.
    while (this.proposals.size >= MAX_PROPOSALS) this.proposals.delete(this.proposals.keys().next().value!);
    const proposal: StructureProposal = { ...input, proposalId: crypto.randomUUID(), createdAt: this.now() };
    this.proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  /** Persist a reviewed proposal as a new row. A proposal saves at most once. */
  save(recordingId: string, proposalId: string): SavedStructure {
    this.prune();
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.recordingId !== recordingId) {
      throw new StructureStoreError(404, 'proposal_not_found', 'That analysis is no longer available to save. Run it again.');
    }
    const id = crypto.randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    this.database.query(`INSERT INTO transcript_structures(id, recording_id, version_id, source_hash, structure, provider, model, created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, recordingId, proposal.versionId, proposal.sourceHash, JSON.stringify(proposal.structure),
      proposal.structure.provider, proposal.structure.model, createdAt);
    this.proposals.delete(proposalId);
    return this.get(recordingId, id)!;
  }

  /** Every saved structure for a recording, newest first. */
  list(recordingId: string): SavedStructure[] {
    const rows = this.database.query(`${SELECT} WHERE recording_id = ? ORDER BY created_at DESC, rowid DESC`).all(recordingId) as Row[];
    const current = this.currentSource(recordingId);
    return rows.map(row => this.toSaved(row, current));
  }

  get(recordingId: string, id: string): SavedStructure | null {
    const row = this.database.query(`${SELECT} WHERE recording_id = ? AND id = ?`).get(recordingId, id) as Row | null;
    return row ? this.toSaved(row, this.currentSource(recordingId)) : null;
  }

  remove(recordingId: string, id: string): boolean {
    return this.database.query('DELETE FROM transcript_structures WHERE recording_id = ? AND id = ?').run(recordingId, id).changes > 0;
  }

  private currentSource(recordingId: string): { versionId: string | null; hash: string | null } {
    const row = this.database.query('SELECT current_version_id AS versionId, full_text AS fullText FROM transcripts WHERE recording_id = ?')
      .get(recordingId) as { versionId: string | null; fullText: string } | null;
    return row ? { versionId: row.versionId, hash: structureSourceHash(row.fullText) } : { versionId: null, hash: null };
  }

  private toSaved(row: Row, current: { versionId: string | null; hash: string | null }): SavedStructure {
    const { structure, ...rest } = row;
    return {
      ...rest,
      structure: JSON.parse(structure) as TranscriptStructure,
      // A legacy transcript has no version ID; fall back to comparing the text it came from.
      current: row.versionId !== null ? row.versionId === current.versionId : row.sourceHash === current.hash,
    };
  }

  private prune(): void {
    const cutoff = this.now() - PROPOSAL_TTL_MS;
    for (const [id, proposal] of this.proposals) if (proposal.createdAt < cutoff) this.proposals.delete(id);
  }
}

const SELECT = `SELECT id, recording_id AS recordingId, version_id AS versionId, source_hash AS sourceHash, structure,
  provider, model, created_at AS createdAt FROM transcript_structures`;

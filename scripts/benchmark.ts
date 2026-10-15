/**
 * REL-08 benchmark. Seeds a throwaway vault in the OS temp directory with synthetic
 * BENCHMARK FIXTURE data (10,000 recordings, 100,000 transcript segments by default),
 * then measures p50/p95 latency of the in-process API for:
 *   list    GET /api/recordings?limit=50&offset=<random>
 *   search  searchTranscripts(<term>)             (FTS5, the /api/search handler)
 *   detail  GET /api/recordings/:id               (includes transcript and segments)
 *
 * It never touches a real vault: DATABASE_URL and OPENPLOD_LIBRARY_PATH are forced to
 * a new temp directory, which is deleted afterwards (pass --keep to inspect it).
 * Provider/network latency is excluded by construction. Results depend on the
 * machine; record the hardware next to any numbers you publish.
 *
 *   bun run bench [--recordings 10000] [--segments-per-recording 10] [--samples 200] [--keep]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

const argument = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? Number(process.argv[index + 1]) : fallback;
};
const recordingCount = argument('recordings', 10000);
const segmentsPerRecording = argument('segments-per-recording', 10);
const samples = argument('samples', 200);
const keep = process.argv.includes('--keep');

const root = mkdtempSync(join(tmpdir(), 'openplod-benchmark-'));
process.env.DATABASE_URL = join(root, 'benchmark.db');
process.env.OPENPLOD_LIBRARY_PATH = join(root, 'recordings');
process.env.OPENPLOD_PAIRING_TOKEN = '';

const { sqlite } = await import('../src/db/client');
const { initializeDatabase } = await import('../src/db/setup');
const { searchTranscripts } = await import('../src/search/transcripts');
const { default: recordingsApi } = await import('../src/api/recordings');

initializeDatabase();

const words = ['budget', 'roadmap', 'customer', 'interview', 'lecture', 'architecture', 'deadline', 'migration', 'invoice', 'hiring',
  'design', 'review', 'latency', 'battery', 'firmware', 'contract', 'meeting', 'summary', 'question', 'decision', 'quarterly', 'launch'];
let seed = 42;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = () => words[Math.floor(random() * words.length)]!;
const sentence = (length: number) => Array.from({ length }, pick).join(' ');

const seedStarted = performance.now();
const ids: string[] = [];
const insertRecording = sqlite.query(`INSERT INTO recordings (id, file_path, original_filename, duration_seconds, file_size_bytes, recording_type,
  status, recorded_at, source_provider, source_transport, fingerprint, retention_state, revision, tags)
  VALUES (?, ?, ?, ?, ?, 'meeting', 'complete', ?, 'upload', 'upload', ?, 'active', 1, '[]')`);
const insertTranscript = sqlite.query(`INSERT INTO transcripts (id, recording_id, full_text, segments, word_count, speaker_count, origin)
  VALUES (?, ?, ?, ?, ?, 2, 'generated')`);
const base = Date.parse('2026-01-01T00:00:00Z');
sqlite.transaction(() => {
  for (let index = 0; index < recordingCount; index++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const segments = Array.from({ length: segmentsPerRecording }, (_, segment) => ({
      id: `s${segment}`, speaker: segment % 2, text: `BENCHMARK FIXTURE ${sentence(18)}.`, start: segment * 30, end: segment * 30 + 29,
    }));
    const fullText = segments.map(segment => segment.text).join('\n');
    insertRecording.run(id, join(process.env.OPENPLOD_LIBRARY_PATH!, `${id}.m4a`), `benchmark-fixture-${index}.m4a`, 1800, 1_000_000,
      new Date(base + index * 3_600_000).toISOString(), `fixture-${index}`);
    insertTranscript.run(crypto.randomUUID(), id, fullText, JSON.stringify(segments), fullText.split(' ').length);
  }
})();
sqlite.exec("INSERT INTO transcripts_fts(transcripts_fts) VALUES ('optimize'); PRAGMA optimize; ANALYZE;");
const seedMs = performance.now() - seedStarted;

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
async function measure(name: string, run: (index: number) => Promise<unknown> | unknown) {
  for (let index = 0; index < 10; index++) await run(index);
  const timings: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    await run(index);
    timings.push(performance.now() - started);
  }
  return { name, samples, p50: percentile(timings, 50), p95: percentile(timings, 95), max: Math.max(...timings) };
}
const expectOk = async (response: Response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); await response.arrayBuffer(); };

const results = [
  await measure('list (50 rows, random page)', () => recordingsApi.request(`/?limit=50&offset=${Math.floor(random() * (recordingCount - 50))}`).then(expectOk)),
  await measure('search (FTS, 1-2 terms)', index => searchTranscripts(index % 2 ? pick() : `${pick()} ${pick()}`)),
  await measure('detail (transcript + segments)', () => recordingsApi.request(`/${ids[Math.floor(random() * ids.length)]}`).then(expectOk)),
];

const report = {
  fixture: { recordings: recordingCount, segments: recordingCount * segmentsPerRecording, seedSeconds: Number((seedMs / 1000).toFixed(1)) },
  machine: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), bun: Bun.version },
  results: results.map(result => ({ ...result, p50: Number(result.p50.toFixed(2)), p95: Number(result.p95.toFixed(2)), max: Number(result.max.toFixed(2)) })),
};
console.log('\nOpenPlod benchmark (synthetic fixture; times in ms, in-process, no network)\n');
console.table(report.results);
console.log(JSON.stringify(report, null, 2));
if (process.env.OPENPLOD_BENCH_OUTPUT) writeFileSync(process.env.OPENPLOD_BENCH_OUTPUT, JSON.stringify(report, null, 2));
sqlite.close();
if (keep) console.log(`Fixture vault kept at ${root}`);
else rmSync(root, { recursive: true, force: true });

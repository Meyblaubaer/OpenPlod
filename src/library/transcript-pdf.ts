import { renderPdf, type PdfBlock, type PdfResult } from './pdf';
import { formatTimestamp } from './structure-export';
import { subtitleReadiness } from './subtitle-export';

/**
 * Readable PDF of one saved transcript version (roadmap TS-09).
 *
 * Generated server-side from the stored version, so the file matches the
 * version the person selected rather than whatever the browser last rendered.
 * Timestamps are printed only when the transcript carries genuine provider
 * timings (the same test the subtitle export uses); a transcript without them
 * says so instead of showing a column of zeros. Unknown metadata is written as
 * "unknown", never filled in.
 */

export interface TranscriptPdfInput {
  title: string;
  recordedAt: string | null;
  source: string | null;
  versionId: string | null;
  origin: string | null;
  provider: string | null;
  model: string | null;
  fullText: string;
  segments: unknown;
}

const speakerName = (speaker: unknown): string | null =>
  typeof speaker === 'string' && speaker.trim() ? speaker.trim()
    : typeof speaker === 'number' && Number.isInteger(speaker) ? `Speaker ${speaker}` : null;

export function transcriptPdf(input: TranscriptPdfInput): PdfResult {
  const blocks: PdfBlock[] = [{ kind: 'title', text: input.title || 'Transcript' }];
  const meta = [
    `Recorded: ${input.recordedAt || 'unknown'}`,
    `Source: ${input.source || 'unknown'}`,
    `Transcript version: ${input.versionId ?? 'legacy (no version ID)'}${input.origin ? ` (${input.origin})` : ''}`,
    ...(input.provider ? [`Transcribed by: ${input.provider}${input.model ? ` ${input.model}` : ''}`] : []),
  ];
  blocks.push({ kind: 'note', text: meta.join('\n') });

  const segments = Array.isArray(input.segments) ? input.segments as Record<string, unknown>[] : [];
  const timed = subtitleReadiness(input.segments).exportable;
  const withText = segments.filter(segment => typeof segment?.text === 'string' && segment.text.trim());

  if (withText.length > 0) {
    if (!timed) blocks.push({ kind: 'note', text: 'This transcript has no usable timings, so passages are not time-stamped.' });
    blocks.push({ kind: 'heading', text: 'Transcript' });
    for (const segment of withText) {
      const start = typeof segment.start === 'number' && Number.isFinite(segment.start) && segment.start >= 0 ? segment.start : null;
      const parts = [timed && start !== null ? `[${formatTimestamp(start)}]` : '', speakerName(segment.speaker) ? `${speakerName(segment.speaker)}:` : '']
        .filter(Boolean);
      blocks.push({ kind: 'paragraph', text: String(segment.text).trim(), ...(parts.length ? { prefix: parts.join(' ') } : {}) });
    }
  } else {
    // No usable segments: print the text itself, split on blank lines.
    blocks.push({ kind: 'heading', text: 'Transcript' });
    const paragraphs = input.fullText.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    if (paragraphs.length === 0) blocks.push({ kind: 'note', text: 'This transcript version is empty.' });
    for (const paragraph of paragraphs) blocks.push({ kind: 'paragraph', text: paragraph });
  }
  return renderPdf({ title: input.title || 'Transcript', blocks });
}

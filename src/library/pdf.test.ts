import { describe, expect, test } from 'bun:test';
import { encodeWinAnsi, renderPdf } from './pdf';
import { transcriptPdf } from './transcript-pdf';
import { renderStructure, structurePdf } from './structure-export';
import type { TranscriptStructure } from './transcript-ai';

/** Pull every hex string drawn with Tj and decode it as WinAnsi/Latin-1 text. */
function drawnText(pdf: string): string {
  return [...pdf.matchAll(/<([0-9A-F]+)> Tj/g)]
    .map(match => Buffer.from(match[1]!, 'hex').toString('latin1'))
    .join('\n');
}

/** Validate the cross-reference table points at each object exactly. */
function assertWellFormed(pdf: string): void {
  expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
  expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  expect(/^[\x00-\x7f]*$/.test(pdf)).toBe(true);
  const startxref = Number(pdf.match(/startxref\n(\d+)\n/)![1]);
  expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
  const count = Number(pdf.slice(startxref).match(/xref\n0 (\d+)\n/)![1]);
  const entries = [...pdf.slice(startxref).matchAll(/(\d{10}) 00000 n \n/g)].map(match => Number(match[1]));
  expect(entries).toHaveLength(count - 1);
  entries.forEach((offset, index) => expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj\n`)).toBe(true));
  for (const match of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = match.index! + match[0].length;
    expect(pdf.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe('\nendstream');
  }
}

describe('WinAnsi encoding', () => {
  test('keeps French and Western European text exactly', () => {
    const { bytes, replaced } = encodeWinAnsi('Décision prise à l’unanimité — coût 5 €, «œuvre»');
    expect(replaced).toBe(0);
    expect(bytes).toContain(0xe9); // é
    expect(bytes).toContain(0x92); // ’
    expect(bytes).toContain(0x97); // —
    expect(bytes).toContain(0x80); // €
    expect(bytes).toContain(0x9c); // œ
  });

  test('strips diacritics WinAnsi lacks rather than dropping the letter', () => {
    expect(encodeWinAnsi('Łódź ā').bytes).toEqual([...Buffer.from('Lodz a', 'latin1')].map((byte, index) => index === 1 ? 0xf3 : byte));
  });

  test('counts characters it cannot represent instead of hiding them', () => {
    const { bytes, replaced } = encodeWinAnsi('会议 ok');
    expect(replaced).toBe(2);
    expect(Buffer.from(bytes).toString('latin1')).toBe('?? ok');
  });

  test('drops invisible characters without counting them as lost', () => {
    expect(encodeWinAnsi('a​b﻿').replaced).toBe(0);
    expect(Buffer.from(encodeWinAnsi('a​b').bytes).toString('latin1')).toBe('ab');
  });
});

describe('PDF writer', () => {
  test('produces a well-formed ASCII file with a correct xref table', () => {
    const { pdf, pages, replaced } = renderPdf({ title: 'Réunion', blocks: [
      { kind: 'title', text: 'Réunion' }, { kind: 'paragraph', text: 'Bonjour à tous.', prefix: '[0:05] Marie:' },
    ] });
    assertWellFormed(pdf);
    expect(pages).toBe(1);
    expect(replaced).toBe(0);
    expect(pdf).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(drawnText(pdf)).toContain('Bonjour à tous.');
    expect(drawnText(pdf)).toContain('[0:05] Marie: ');
    expect(drawnText(pdf)).toContain('Page 1 of 1');
  });

  test('wraps long paragraphs and breaks pages, numbering every page', () => {
    const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
    const { pdf, pages } = renderPdf({ title: 'Long', blocks: Array.from({ length: 12 }, () => ({ kind: 'paragraph' as const, text: long })) });
    assertWellFormed(pdf);
    expect(pages).toBeGreaterThan(3);
    expect(pdf.match(/\/Type \/Page /g)).toHaveLength(pages);
    expect(drawnText(pdf)).toContain(`Page ${pages} of ${pages}`);
    // Every word survives wrapping.
    expect(drawnText(pdf).replace(/\s+/g, ' ')).toContain('word398 word399');
  });

  test('hard-breaks a single word wider than the page', () => {
    const { pdf } = renderPdf({ title: 't', blocks: [{ kind: 'paragraph', text: 'x'.repeat(500) }] });
    assertWellFormed(pdf);
    expect(drawnText(pdf).replace(/\s+/g, '')).toContain('x'.repeat(500));
  });

  test('adds a visible note when characters had to be replaced', () => {
    const { pdf, replaced } = renderPdf({ title: 'Mixed', blocks: [{ kind: 'title', text: 'Mixed' }, { kind: 'paragraph', text: 'Привет' }] });
    expect(replaced).toBe(6);
    expect(drawnText(pdf)).toContain('6 characters could not be shown');
  });

  test('keeps the full title in UTF-16 metadata', () => {
    const { pdf } = renderPdf({ title: 'Été', blocks: [] });
    expect(pdf).toContain('/Title <FEFF00C9007400E9>');
    assertWellFormed(pdf);
  });
});

describe('transcript PDF', () => {
  const base = { title: 'Team sync', recordedAt: '2026-09-05T10:00:00Z', source: 'plaud', versionId: 'v1', origin: 'generated', provider: 'mistral', model: 'voxtral-mini' };

  test('prints real timings and speakers when the segments carry them', () => {
    const { pdf } = transcriptPdf({ ...base, fullText: 'Hello. Bye.', segments: [
      { start: 0, end: 4, text: 'Hello.', speaker: 0 }, { start: 65, end: 70, text: 'Bye.', speaker: 'Marie' },
    ] });
    assertWellFormed(pdf);
    const text = drawnText(pdf);
    expect(text).toContain('[0:00] Speaker 0: ');
    expect(text).toContain('[1:05] Marie: ');
    expect(text).toContain('Transcribed by: mistral voxtral-mini');
    expect(text).not.toContain('no usable timings');
  });

  test('never prints zero timestamps for a transcript without timings', () => {
    const { pdf } = transcriptPdf({ ...base, fullText: 'Hello. Bye.', segments: [
      { start: 0, end: 0, text: 'Hello.' }, { start: 0, end: 0, text: 'Bye.' },
    ] });
    const text = drawnText(pdf);
    expect(text).toContain('no usable timings');
    expect(text).not.toContain('[0:00]');
  });

  test('falls back to the text and keeps unknown metadata unknown', () => {
    const { pdf } = transcriptPdf({ ...base, recordedAt: null, source: null, versionId: null, provider: null, model: null,
      fullText: 'First paragraph.\n\nSecond paragraph.', segments: null });
    const text = drawnText(pdf);
    expect(text).toContain('Recorded: unknown');
    expect(text).toContain('legacy (no version ID)');
    expect(text).not.toContain('Transcribed by');
    expect(text).toContain('Second paragraph.');
  });
});

describe('structure PDF', () => {
  const structure: TranscriptStructure = {
    chapters: [{ title: 'Budget', text: 'Budget', startSeconds: 64, segmentIndex: 1 }],
    decisions: [{ text: 'Postpone the launch.', startSeconds: null, segmentIndex: null }],
    actionItems: [{ text: 'Book the venue.', owner: null, due: null, startSeconds: null, segmentIndex: null }],
    openQuestions: [], provider: 'mistral', model: 'm', usage: null, timestampsAvailable: true,
  };

  test('renders sections with timestamps only where resolved and unknown owners unset', () => {
    const pdf = structurePdf(structure, 'Sync');
    assertWellFormed(pdf);
    const text = drawnText(pdf);
    expect(text).toContain('[1:04] ');
    expect(text).toContain('Postpone the launch.');
    expect(text).toContain('owner: not stated, due: not stated');
    expect(text).not.toContain('Open questions');
    expect(renderStructure('pdf', structure)).toBe(structurePdf(structure));
  });
});

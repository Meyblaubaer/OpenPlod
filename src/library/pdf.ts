/**
 * A small, dependency-free PDF writer for readable text documents (roadmap TS-09).
 *
 * Scope is deliberately narrow: titles, headings, wrapped paragraphs, bullets,
 * notes, page breaks and page numbers. That is all a transcript or a structure
 * export needs, and it keeps the PDF generated server-side without bundling a
 * PDF engine or relying on the browser's print dialog.
 *
 * Fonts are the PDF standard-14 Helvetica family with WinAnsiEncoding, so no
 * font is embedded. WinAnsi covers English and Western European text (French
 * accents, ligatures, curly quotes, dashes, the euro sign). Anything outside it
 * is handled in this order, and never silently:
 *
 *  1. typographic variants are mapped to their plain equivalent (odd spaces,
 *     hyphens, primes);
 *  2. letters with diacritics outside WinAnsi lose the diacritic (ā → a);
 *  3. anything still unrepresentable becomes "?" and is *counted*. When the
 *     count is non-zero, the document carries a visible note saying so and
 *     pointing to the text exports, which keep the exact characters.
 *
 * The output is pure 7-bit ASCII: strings are written as hex and streams are
 * uncompressed. That makes byte offsets equal to string offsets and lets the
 * file travel through any text-only export path unchanged.
 */

export type PdfBlock =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  /** `prefix` renders in bold before the text, e.g. a timestamp and speaker. */
  | { kind: 'paragraph'; text: string; prefix?: string }
  | { kind: 'bullet'; text: string; prefix?: string }
  /** Small grey italic text for metadata and caveats. */
  | { kind: 'note'; text: string };

export interface PdfDocument {
  /** Document title, used for metadata and the running footer. */
  title: string;
  blocks: PdfBlock[];
}

export interface PdfResult {
  /** The complete file. ASCII only, so `pdf.length` is its byte length. */
  pdf: string;
  pages: number;
  /** Characters that could not be represented and were drawn as "?". */
  replaced: number;
}

// ---------------------------------------------------------------------------
// WinAnsi encoding
// ---------------------------------------------------------------------------

/** The 0x80–0x9F block of WinAnsiEncoding; 0xA0–0xFF match Latin-1. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const WIN_ANSI_TO_UNICODE = new Map(Object.entries(WIN_ANSI_HIGH).map(([code, byte]) => [byte, Number(code)]));

/** Plain equivalents for common characters outside WinAnsi. */
const SUBSTITUTES: Record<string, string> = {
  '‐': '-', '‑': '-', '‒': '-', '―': '-', '−': '-',
  '′': "'", '″': '"', '‵': "'", '‛': "'", '‟': '"',
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H',
  '←': '<-', '→': '->', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~',
};
const DROPPED = /[​-‍⁠﻿­]/;
const SPACES = /[ -   　]/;

function encodeCodePoint(codePoint: number): number | null {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return WIN_ANSI_HIGH[codePoint] ?? null;
}

/**
 * Encode text as WinAnsi bytes. Line breaks and tabs become spaces here; the
 * layout splits paragraphs on newlines before calling this.
 */
export function encodeWinAnsi(text: string): { bytes: number[]; replaced: number } {
  const bytes: number[] = [];
  let replaced = 0;
  for (const character of text.normalize('NFC')) {
    if (character === '\n' || character === '\r' || character === '\t') { bytes.push(0x20); continue; }
    if (DROPPED.test(character)) continue;
    if (SPACES.test(character)) { bytes.push(0x20); continue; }
    const direct = encodeCodePoint(character.codePointAt(0)!);
    if (direct !== null) { bytes.push(direct); continue; }
    const substitute = SUBSTITUTES[character];
    if (substitute) { bytes.push(...[...substitute].map(value => value.charCodeAt(0))); continue; }
    // Strip diacritics the encoding lacks, but only if what remains is encodable.
    const stripped = character.normalize('NFKD').replace(/\p{M}/gu, '');
    const fallback = stripped ? [...stripped].map(value => encodeCodePoint(value.codePointAt(0)!)) : [];
    if (fallback.length > 0 && fallback.every(value => value !== null)) { bytes.push(...fallback as number[]); continue; }
    bytes.push(0x3f);
    replaced += 1;
  }
  return { bytes, replaced };
}

// ---------------------------------------------------------------------------
// Metrics (Adobe AFM advance widths, 1/1000 em)
// ---------------------------------------------------------------------------

const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Wide or narrow high-byte glyphs whose width is not their base letter's. */
const HIGH_OVERRIDES: Record<number, number> = {
  0x80: 556, 0x85: 1000, 0x89: 1000, 0x8c: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333,
  0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000, 0x9c: 944, 0xa0: 278, 0xa9: 737, 0xae: 737,
  0xb0: 400, 0xc6: 1000, 0xd7: 584, 0xdf: 611, 0xe6: 889, 0xf7: 584,
};

function widthTable(ascii: number[]): number[] {
  const table = new Array<number>(256).fill(556);
  ascii.forEach((width, index) => { table[index + 32] = width; });
  for (let byte = 0x80; byte <= 0xff; byte += 1) {
    if (HIGH_OVERRIDES[byte] !== undefined) { table[byte] = HIGH_OVERRIDES[byte]!; continue; }
    // An accented letter is as wide as its base letter in Helvetica.
    const base = String.fromCodePoint(WIN_ANSI_TO_UNICODE.get(byte) ?? byte).normalize('NFD')[0]!.charCodeAt(0);
    if (base >= 32 && base <= 126) table[byte] = ascii[base - 32]!;
  }
  return table;
}

type FontKey = 'F1' | 'F2' | 'F3';
const WIDTHS: Record<FontKey, number[]> = {
  F1: widthTable(HELVETICA_ASCII),
  F2: widthTable(HELVETICA_BOLD_ASCII),
  // Helvetica-Oblique shares Helvetica's metrics.
  F3: widthTable(HELVETICA_ASCII),
};
const BASE_FONT: Record<FontKey, string> = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Helvetica-Oblique' };

const measure = (bytes: number[], font: FontKey, size: number): number =>
  bytes.reduce((total, byte) => total + WIDTHS[font][byte]!, 0) * size / 1000;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const BOTTOM = MARGIN + 18;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const BULLET_INDENT = 14;

interface Style { font: FontKey; size: number; leading: number; before: number; after: number; grey: boolean }
const STYLES: Record<PdfBlock['kind'], Style> = {
  title: { font: 'F2', size: 18, leading: 23, before: 0, after: 8, grey: false },
  heading: { font: 'F2', size: 13, leading: 17, before: 12, after: 4, grey: false },
  paragraph: { font: 'F1', size: 10.5, leading: 14, before: 0, after: 5, grey: false },
  bullet: { font: 'F1', size: 10.5, leading: 14, before: 0, after: 3, grey: false },
  note: { font: 'F3', size: 9, leading: 12, before: 0, after: 4, grey: true },
};

interface Word { bytes: number[]; font: FontKey }
interface Run { bytes: number[]; font: FontKey }
interface Line { runs: Run[]; x: number; y: number; size: number; grey: boolean }

const toWords = (text: string, font: FontKey): Word[] =>
  text.split(/[ \t]+/).filter(Boolean).map(word => ({ bytes: encodeWinAnsi(word).bytes, font }));

/** Split a word wider than the line into pieces that fit. */
function breakWord(word: Word, size: number, width: number): Word[] {
  const pieces: Word[] = [];
  let current: number[] = [];
  for (const byte of word.bytes) {
    if (current.length > 0 && measure([...current, byte], word.font, size) > width) {
      pieces.push({ bytes: current, font: word.font });
      current = [];
    }
    current.push(byte);
  }
  if (current.length > 0) pieces.push({ bytes: current, font: word.font });
  return pieces;
}

/** Greedy word wrap of mixed-font words into lines of runs. */
function wrap(words: Word[], size: number, width: number): Run[][] {
  const lines: Run[][] = [];
  let line: Word[] = [];
  let lineWidth = 0;
  const flush = () => {
    if (line.length === 0) return;
    const runs: Run[] = [];
    line.forEach((word, index) => {
      const bytes = index < line.length - 1 ? [...word.bytes, 0x20] : word.bytes;
      const last = runs.at(-1);
      if (last && last.font === word.font) last.bytes.push(...bytes);
      else runs.push({ bytes: [...bytes], font: word.font });
    });
    lines.push(runs);
    line = []; lineWidth = 0;
  };
  for (const original of words) {
    for (const word of measure(original.bytes, original.font, size) > width ? breakWord(original, size, width) : [original]) {
      const wordWidth = measure(word.bytes, word.font, size);
      const space = line.length > 0 ? measure([0x20], line.at(-1)!.font, size) : 0;
      if (line.length > 0 && lineWidth + space + wordWidth > width) flush();
      lineWidth += (line.length > 0 ? measure([0x20], line.at(-1)!.font, size) : 0) + wordWidth;
      line.push(word);
    }
  }
  flush();
  return lines;
}

/** Lay every block out into pages of positioned lines. */
function layout(blocks: PdfBlock[]): { pages: Line[][]; bullets: { page: number; x: number; y: number; size: number }[] } {
  const pages: Line[][] = [[]];
  const bullets: { page: number; x: number; y: number; size: number }[] = [];
  let y = PAGE_HEIGHT - MARGIN;
  const newPage = () => { pages.push([]); y = PAGE_HEIGHT - MARGIN; };
  const atTop = () => y === PAGE_HEIGHT - MARGIN;

  for (const block of blocks) {
    const style = STYLES[block.kind];
    const indent = block.kind === 'bullet' ? BULLET_INDENT : 0;
    const width = CONTENT_WIDTH - indent;
    // Explicit newlines are line breaks inside one block.
    const paragraphs = block.text.split(/\r?\n/);
    const lines: Run[][] = [];
    paragraphs.forEach((paragraph, index) => {
      const prefix = index === 0 && 'prefix' in block && block.prefix ? toWords(block.prefix, 'F2') : [];
      const words = [...prefix, ...toWords(paragraph, style.font)];
      const wrapped = wrap(words, style.size, width);
      lines.push(...(wrapped.length > 0 ? wrapped : [[]]));
    });
    if (!atTop()) y -= style.before;
    // Keep a heading with at least two lines of what follows.
    const keep = block.kind === 'heading' || block.kind === 'title' ? style.leading + 2 * STYLES.paragraph.leading : style.leading;
    if (y - keep < BOTTOM && !atTop()) newPage();
    lines.forEach((runs, index) => {
      if (y - style.leading < BOTTOM) newPage();
      y -= style.leading;
      if (index === 0 && block.kind === 'bullet') bullets.push({ page: pages.length - 1, x: MARGIN + 2, y, size: style.size });
      if (runs.length > 0) pages.at(-1)!.push({ runs, x: MARGIN + indent, y, size: style.size, grey: style.grey });
    });
    y -= style.after;
  }
  return { pages, bullets };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const hex = (bytes: number[]): string => `<${bytes.map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;
const num = (value: number): string => (Math.round(value * 100) / 100).toString();

/** Metadata strings use UTF-16BE so the title keeps every character. */
function utf16Hex(text: string): string {
  let out = 'FEFF';
  for (let index = 0; index < text.length; index += 1) out += text.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase();
  return `<${out}>`;
}

function pageStream(lines: Line[], bullets: { x: number; y: number; size: number }[], footer: number[]): string {
  const ops: string[] = [];
  for (const line of lines) {
    ops.push('BT', line.grey ? '0.4 g' : '0 g', `${num(line.x)} ${num(line.y)} Td`);
    for (const run of line.runs) ops.push(`/${run.font} ${num(line.size)} Tf`, `${hex(run.bytes)} Tj`);
    ops.push('ET');
  }
  for (const bullet of bullets) ops.push('BT', '0 g', `/F1 ${num(bullet.size)} Tf`, `${num(bullet.x)} ${num(bullet.y)} Td`, `${hex([0x95])} Tj`, 'ET');
  const footerWidth = measure(footer, 'F1', 8);
  ops.push('BT', '0.4 g', '/F1 8 Tf', `${num(PAGE_WIDTH - MARGIN - footerWidth)} ${num(MARGIN - 18)} Td`, `${hex(footer)} Tj`, 'ET');
  return ops.join('\n');
}

/** Render a document to a complete PDF file. */
export function renderPdf(document: PdfDocument): PdfResult {
  const replaced = document.blocks.reduce((total, block) =>
    total + encodeWinAnsi(block.text).replaced + ('prefix' in block && block.prefix ? encodeWinAnsi(block.prefix).replaced : 0), 0);
  const blocks = [...document.blocks];
  if (replaced > 0) {
    // Say so where it will be seen: straight after the title.
    const at = blocks[0]?.kind === 'title' ? 1 : 0;
    blocks.splice(at, 0, { kind: 'note', text:
      `${replaced} character${replaced === 1 ? '' : 's'} could not be shown with this PDF's built-in font and appear as "?". `
      + 'The Markdown, text and JSON exports keep the exact text.' });
  }

  const { pages, bullets } = layout(blocks);
  const titleBytes = encodeWinAnsi(document.title.slice(0, 80)).bytes;
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };

  const catalog = add('');
  const pagesRoot = add('');
  const fonts = (['F1', 'F2', 'F3'] as const).map(key =>
    [key, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${BASE_FONT[key]} /Encoding /WinAnsiEncoding >>`)] as const);
  const info = add(`<< /Title ${utf16Hex(document.title.slice(0, 300))} /Producer (OpenPlod) >>`);
  const resources = `<< /Font << ${fonts.map(([key, id]) => `/${key} ${id} 0 R`).join(' ')} >> >>`;

  const pageIds = pages.map((lines, index) => {
    const footer = [...titleBytes, ...encodeWinAnsi(`  ·  Page ${index + 1} of ${pages.length}`).bytes];
    const stream = pageStream(lines, bullets.filter(bullet => bullet.page === index), footer);
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
  objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { pdf, pages: pages.length, replaced };
}

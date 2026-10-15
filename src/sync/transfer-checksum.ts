/**
 * REL-02: Plaud transfer-tail checksum validation.
 *
 * The device ends every recording download with a control packet (opcode 29) that
 * carries a 16-bit value after the session ID. The repository has no captured
 * real-device transfer (no fixture, no saved `device-original.plaud` with its
 * tail value, no vendor documentation) that identifies which CRC-16 variant the
 * firmware uses, or over which bytes. Until such evidence exists the algorithm is
 * *unconfirmed*:
 *
 * - every candidate below is computed over the downloaded bytes;
 * - the outcome is recorded in provenance as `unverified-algorithm` together with
 *   the candidates that happened to match (evidence for a later confirmation);
 * - a transfer is never rejected on an unconfirmed algorithm.
 *
 * Once a real capture confirms exactly one variant, set `CONFIRMED_TAIL_ALGORITHM`
 * (and the Kotlin mirror in DirectPlaudProtocol.kt). From then on a mismatch fails
 * the import without deleting any received bytes.
 */

export type Crc16Variant = {
  name: string; poly: number; init: number; refIn: boolean; refOut: boolean; xorOut: number;
  /** Published check value over ASCII "123456789" (reveng catalogue), used by the tests. */
  check: number;
};

export const CRC16_VARIANTS: readonly Crc16Variant[] = [
  { name: 'CRC-16/CCITT-FALSE', poly: 0x1021, init: 0xffff, refIn: false, refOut: false, xorOut: 0x0000, check: 0x29b1 },
  { name: 'CRC-16/XMODEM', poly: 0x1021, init: 0x0000, refIn: false, refOut: false, xorOut: 0x0000, check: 0x31c3 },
  { name: 'CRC-16/KERMIT', poly: 0x1021, init: 0x0000, refIn: true, refOut: true, xorOut: 0x0000, check: 0x2189 },
  { name: 'CRC-16/X-25', poly: 0x1021, init: 0xffff, refIn: true, refOut: true, xorOut: 0xffff, check: 0x906e },
  { name: 'CRC-16/MCRF4XX', poly: 0x1021, init: 0xffff, refIn: true, refOut: true, xorOut: 0x0000, check: 0x6f91 },
  { name: 'CRC-16/GENIBUS', poly: 0x1021, init: 0xffff, refIn: false, refOut: false, xorOut: 0xffff, check: 0xd64e },
  { name: 'CRC-16/SPI-FUJITSU', poly: 0x1021, init: 0x1d0f, refIn: false, refOut: false, xorOut: 0x0000, check: 0xe5cc },
  { name: 'CRC-16/MODBUS', poly: 0x8005, init: 0xffff, refIn: true, refOut: true, xorOut: 0x0000, check: 0x4b37 },
  { name: 'CRC-16/ARC', poly: 0x8005, init: 0x0000, refIn: true, refOut: true, xorOut: 0x0000, check: 0xbb3d },
  { name: 'CRC-16/USB', poly: 0x8005, init: 0xffff, refIn: true, refOut: true, xorOut: 0xffff, check: 0xb4c8 },
  { name: 'CRC-16/UMTS', poly: 0x8005, init: 0x0000, refIn: false, refOut: false, xorOut: 0x0000, check: 0xfee8 },
];

/** No real-device evidence identifies the variant yet; see the module comment. */
export const CONFIRMED_TAIL_ALGORITHM: string | null = null;

const reflect = (value: number, bits: number) => {
  let out = 0;
  for (let i = 0; i < bits; i++) if (value & (1 << i)) out |= 1 << (bits - 1 - i);
  return out;
};

const tables = new Map<string, Uint16Array>();
function table(variant: Crc16Variant) {
  let result = tables.get(variant.name);
  if (result) return result;
  result = new Uint16Array(256);
  const poly = variant.refIn ? reflect(variant.poly, 16) : variant.poly;
  for (let n = 0; n < 256; n++) {
    let crc = variant.refIn ? n : n << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = variant.refIn ? (crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1)
        : (crc & 0x8000 ? (crc << 1) ^ poly : crc << 1) & 0xffff;
    }
    result[n] = crc & 0xffff;
  }
  tables.set(variant.name, result);
  return result;
}

export function crc16(variant: Crc16Variant, bytes: Uint8Array): number {
  const lookup = table(variant);
  let crc = variant.refIn ? reflect(variant.init, 16) : variant.init;
  if (variant.refIn) for (const byte of bytes) crc = (crc >>> 8) ^ lookup[(crc ^ byte) & 0xff]!;
  else for (const byte of bytes) crc = ((crc << 8) & 0xffff) ^ lookup[((crc >>> 8) ^ byte) & 0xff]!;
  if (variant.refIn !== variant.refOut) crc = reflect(crc, 16);
  return (crc ^ variant.xorOut) & 0xffff;
}

export type TailChecksumResult = {
  status: 'verified' | 'mismatch' | 'unverified-algorithm';
  /** The enforced algorithm, or null while none is confirmed. */
  algorithm: string | null;
  /** The 16-bit value from the tail packet (read little-endian, as received). */
  tailValue: number;
  /** Unconfirmed candidates whose result equalled the tail value (either byte order). Evidence only. */
  candidateMatches: { algorithm: string; byteOrder: 'le' | 'be' }[];
};

const swap16 = (value: number) => ((value & 0xff) << 8) | (value >>> 8);

/**
 * Classifies the tail value. With no confirmed algorithm the status is always
 * `unverified-algorithm`, whatever the candidates say.
 */
export function evaluateTailChecksum(bytes: Uint8Array, tailValue: number,
  confirmed: string | null = CONFIRMED_TAIL_ALGORITHM): TailChecksumResult {
  const candidateMatches: TailChecksumResult['candidateMatches'] = [];
  for (const variant of CRC16_VARIANTS) {
    const value = crc16(variant, bytes);
    if (value === tailValue) candidateMatches.push({ algorithm: variant.name, byteOrder: 'le' });
    else if (swap16(value) === tailValue) candidateMatches.push({ algorithm: variant.name, byteOrder: 'be' });
  }
  if (!confirmed) return { status: 'unverified-algorithm', algorithm: null, tailValue, candidateMatches };
  const variant = CRC16_VARIANTS.find(item => item.name === confirmed);
  if (!variant) throw new Error(`Unknown confirmed transfer checksum algorithm ${confirmed}`);
  return { status: crc16(variant, bytes) === tailValue ? 'verified' : 'mismatch', algorithm: variant.name, tailValue, candidateMatches };
}

export class TransferChecksumMismatch extends Error {
  constructor(readonly result: TailChecksumResult) {
    super(`Plaud transfer checksum mismatch (${result.algorithm}). Received bytes were kept; the recording was not imported.`);
  }
}

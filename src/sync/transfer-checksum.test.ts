import { expect, test } from 'bun:test';
import { CONFIRMED_TAIL_ALGORITHM, CRC16_VARIANTS, crc16, evaluateTailChecksum } from './transfer-checksum';

test('every CRC-16 candidate reproduces its published check value', () => {
  const input = Buffer.from('123456789');
  for (const variant of CRC16_VARIANTS) expect({ name: variant.name, value: crc16(variant, input) }).toEqual({ name: variant.name, value: variant.check });
});

test('no tail algorithm is confirmed without real-device evidence', () => {
  expect(CONFIRMED_TAIL_ALGORITHM).toBeNull();
  // The only tail in the repository is a synthetic test packet (0xffff over 01 02 03 04).
  const result = evaluateTailChecksum(Buffer.from([1, 2, 3, 4]), 0xffff);
  expect(result.status).toBe('unverified-algorithm');
  expect(result.algorithm).toBeNull();
  expect(result.candidateMatches).toEqual([]);
});

test('unconfirmed candidate matches are recorded as evidence, never as verification', () => {
  const bytes = Buffer.from('plaud transfer');
  const xmodem = CRC16_VARIANTS.find(variant => variant.name === 'CRC-16/XMODEM')!;
  const value = crc16(xmodem, bytes);
  const result = evaluateTailChecksum(bytes, value);
  expect(result.status).toBe('unverified-algorithm');
  expect(result.candidateMatches).toContainEqual({ algorithm: 'CRC-16/XMODEM', byteOrder: 'le' });
});

test('a confirmed algorithm verifies or reports a mismatch', () => {
  const bytes = Buffer.from('plaud transfer');
  const kermit = CRC16_VARIANTS.find(variant => variant.name === 'CRC-16/KERMIT')!;
  expect(evaluateTailChecksum(bytes, crc16(kermit, bytes), 'CRC-16/KERMIT').status).toBe('verified');
  expect(evaluateTailChecksum(bytes, crc16(kermit, bytes) ^ 1, 'CRC-16/KERMIT').status).toBe('mismatch');
  expect(() => evaluateTailChecksum(bytes, 0, 'CRC-16/NOPE')).toThrow('Unknown');
});

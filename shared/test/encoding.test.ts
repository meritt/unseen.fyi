import { describe, expect, test } from 'bun:test';

import { base64urlDecode, base64urlEncode, hexDecode, hexEncode } from '../src/crypto/encoding.ts';

describe('hex codec', () => {
  test('round-trips 32-byte buffers', () => {
    const raw = new Uint8Array(32);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = i * 7 + 3;
    }
    expect(hexDecode(hexEncode(raw))).toEqual(raw);
  });

  test('matches the canonical lowercase form', () => {
    expect(hexEncode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
    expect(hexDecode('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('rejects odd-length and non-hex input', () => {
    expect(() => hexDecode('abc')).toThrow(SyntaxError);
    expect(() => hexDecode('zz')).toThrow(SyntaxError);
  });
});

describe('base64url codec', () => {
  test('round-trips arbitrary byte sequences', () => {
    for (const length of [0, 1, 16, 31, 32, 64, 100]) {
      const raw = new Uint8Array(length);
      crypto.getRandomValues(raw);
      expect(base64urlDecode(base64urlEncode(raw))).toEqual(raw);
    }
  });

  test('produces 43 unpadded chars for 32 bytes', () => {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const encoded = base64urlEncode(raw);
    expect(encoded.length).toBe(43);
    expect(encoded.includes('=')).toBe(false);
    expect(encoded.includes('+')).toBe(false);
    expect(encoded.includes('/')).toBe(false);
  });

  test('matches a known fixture', () => {
    const raw = new Uint8Array([0xff, 0xfb, 0xef]);
    expect(base64urlEncode(raw)).toBe('__vv');
    expect(base64urlDecode('__vv')).toEqual(raw);
  });
});

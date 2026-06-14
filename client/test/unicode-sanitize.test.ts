import { describe, expect, test } from 'bun:test';

import { sanitizeUnicode, ZERO_WIDTH_RE } from '../src/domain/unicode-sanitize.ts';

describe('unicode sanitization', () => {
  test('strips bidi RLO so a reversed tail becomes plain text', () => {
    const input = `Hello‮olleH`;
    expect(sanitizeUnicode(input)).toBe('HelloolleH');
  });

  test('strips the full bidi-control range', () => {
    const bidi = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'].join('');
    expect(sanitizeUnicode(`a${bidi}b`)).toBe('ab');
  });

  test('strips implicit directional marks LRM, RLM and ALM', () => {
    const input = '1\u200E2\u200F3\u061C4';
    expect(sanitizeUnicode(input)).toBe('1234');
  });

  test('applies NFC normalization', () => {
    const decomposed = 'é';
    expect(sanitizeUnicode(decomposed)).toBe('é');
  });

  test('caps Zalgo-style combining-mark runs to 4', () => {
    const base = 'a';
    const combining = '́'.repeat(8);
    const result = sanitizeUnicode(base + combining);
    let combiningCount = 0;
    for (const ch of result) {
      if (/\p{Mn}/u.test(ch)) {
        combiningCount += 1;
      }
    }
    expect(combiningCount).toBeLessThanOrEqual(4);
  });

  test('preserves zero-width characters intact', () => {
    const input = 'paypal​.com';
    const out = sanitizeUnicode(input);
    expect(out).toBe(input);
    expect(ZERO_WIDTH_RE.test(out)).toBe(true);
  });

  test('flags the broadened invisible set (word joiner, soft hyphen, hangul filler)', () => {
    expect(ZERO_WIDTH_RE.test('\u2060')).toBe(true);
    expect(ZERO_WIDTH_RE.test('\u00AD')).toBe(true);
    expect(ZERO_WIDTH_RE.test('\u3164')).toBe(true);
    expect(sanitizeUnicode('a\u2060b')).toBe('a\u2060b');
  });

  test('passes legitimate text through unchanged', () => {
    expect(sanitizeUnicode('Hello, world!')).toBe('Hello, world!');
    expect(sanitizeUnicode('Привет, мир!')).toBe('Привет, мир!');
    expect(sanitizeUnicode('日本語')).toBe('日本語');
  });

  test('keeps 1-3 combining marks intact (legitimate diacritics)', () => {
    expect(sanitizeUnicode('tiếng')).toBe('tiếng');
  });
});

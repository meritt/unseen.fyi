import { describe, expect, test } from 'bun:test';

import { sanitizeFilename } from '../src/domain/unicode-sanitize.ts';

describe('sanitizeFilename happy path', () => {
  test('plain ASCII name passes through unchanged', () => {
    expect(sanitizeFilename('hello.txt')).toBe('hello.txt');
  });

  test('Cyrillic and emoji preserved when under byte cap', () => {
    expect(sanitizeFilename('\u0444\u0430\u0439\u043B\u{1F3B5}.txt')).toBe(
      '\u0444\u0430\u0439\u043B\u{1F3B5}.txt',
    );
  });

  test('NFC normalises decomposed to precomposed', () => {
    const decomposed = 'D\u0438\u0301'.normalize('NFD');
    const composed = 'D\u0438\u0301'.normalize('NFC');
    expect(sanitizeFilename(decomposed)).toBe(composed);
  });
});

describe('sanitizeFilename bidi / invisible stripping', () => {
  test('strips bidi-override U+202E RLO leaving the rest intact', () => {
    expect(sanitizeFilename('evil\u202Etxt.exe')).toBe('eviltxt.exe');
  });

  test('strips U+FEFF BOM', () => {
    expect(sanitizeFilename('hello\uFEFF.txt')).toBe('hello.txt');
  });

  test('strips U+200E LRM', () => {
    expect(sanitizeFilename('hello\u200E.txt')).toBe('hello.txt');
  });

  test('strips U+200F RLM', () => {
    expect(sanitizeFilename('hello\u200F.txt')).toBe('hello.txt');
  });
});

describe('sanitizeFilename control + path scrubbing', () => {
  test('control chars become underscore', () => {
    expect(sanitizeFilename('\u0000hello\u001F')).toBe('_hello_');
  });

  test('all common path separators rewrite to underscore', () => {
    expect(sanitizeFilename(String.raw`a/b\c:d|e`)).toBe('a_b_c_d_e');
  });

  test('control-only input still returns underscores (non-empty result, not null)', () => {
    expect(sanitizeFilename('\u0000\u0001\u0002')).toBe('___');
  });
});

describe('sanitizeFilename UTF-8 byte cap (255)', () => {
  test('300 ASCII bytes truncated to 255', () => {
    const input = 'a'.repeat(300);
    const out = sanitizeFilename(input);
    expect(out).not.toBeNull();
    const encoded = new TextEncoder().encode(out ?? '');
    expect(encoded.byteLength).toBeLessThanOrEqual(255);
    expect(encoded.byteLength).toBe(255);
  });

  test('multi-byte input lands on safe code-point boundary', () => {
    const input = '\u0444'.repeat(200);
    const out = sanitizeFilename(input);
    expect(out).not.toBeNull();
    if (out === null) {
      return;
    }
    const encoded = new TextEncoder().encode(out);
    expect(encoded.byteLength).toBeLessThanOrEqual(255);
    expect(encoded.byteLength % 2).toBe(0);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded)).toBe(out);
  });
});

describe('sanitizeFilename leading-dot handling (spec section 7.3 step 7)', () => {
  test('plain leading dot gets underscore prepended', () => {
    expect(sanitizeFilename('.bashrc')).toBe('_.bashrc');
  });

  test('double-leading dot also gets prepended (not exact "..")', () => {
    expect(sanitizeFilename('..env')).toBe('_..env');
  });

  test('plain dot inside the name is untouched', () => {
    expect(sanitizeFilename('file.tar.gz')).toBe('file.tar.gz');
  });
});

describe('sanitizeFilename rejected inputs', () => {
  test('exact "." returns null', () => {
    expect(sanitizeFilename('.')).toBeNull();
  });

  test('exact ".." returns null', () => {
    expect(sanitizeFilename('..')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(sanitizeFilename('')).toBeNull();
  });

  test('input that NFC-normalises to "." returns null', () => {
    expect(sanitizeFilename('.'.normalize('NFC'))).toBeNull();
  });
});

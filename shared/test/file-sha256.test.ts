import { describe, expect, test } from 'bun:test';

import type { Bytes } from '../src/crypto/encoding.ts';
import { createSha256Stream } from '../src/crypto/file-sha256.ts';

const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const MILLION_A_DIGEST = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

const randomBuffer = (length: number): Bytes => {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
};

const hashChunks = (chunks: readonly Bytes[]): string => {
  const stream = createSha256Stream();
  for (const chunk of chunks) {
    stream.update(chunk);
  }
  return stream.digest();
};

const sliceFixed = (buffer: Bytes, size: number): Bytes[] => {
  const out: Bytes[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    out.push(buffer.slice(offset, Math.min(offset + size, buffer.length)));
  }
  return out;
};

const sliceIrregular = (buffer: Bytes, sizes: readonly number[]): Bytes[] => {
  const out: Bytes[] = [];
  let offset = 0;
  let cursor = 0;
  while (offset < buffer.length) {
    const size = sizes[cursor % sizes.length] ?? 1;
    const end = Math.min(offset + size, buffer.length);
    out.push(buffer.slice(offset, end));
    offset = end;
    cursor += 1;
  }
  return out;
};

describe('sha256 streaming wrapper — NIST KAT', () => {
  test('empty input matches the canonical empty SHA-256 digest', () => {
    const stream = createSha256Stream();
    expect(stream.digest()).toBe(EMPTY_DIGEST);
  });

  test('"abc" single-shot digest matches FIPS 180-4 example', () => {
    const stream = createSha256Stream();
    stream.update(encode('abc'));
    expect(stream.digest()).toBe(ABC_DIGEST);
  });

  test('million-byte "a" digest matches FIPS 180-4 long-message example (chunked feed)', () => {
    const chunkSize = 100_000;
    const stream = createSha256Stream();
    const chunk = new Uint8Array(chunkSize).fill(0x61);
    for (let i = 0; i < 10; i++) {
      stream.update(chunk);
    }
    expect(stream.digest()).toBe(MILLION_A_DIGEST);
  });
});

describe('sha256 streaming wrapper — streaming equals single-shot', () => {
  test('random 32 KiB buffer hashes identically under several chunking patterns', () => {
    const total = 32 * 1024;
    const buffer = randomBuffer(total);

    const singleShot = hashChunks([buffer]);

    const fixed1k = hashChunks(sliceFixed(buffer, 1024));
    expect(fixed1k).toBe(singleShot);

    const irregular = hashChunks(sliceIrregular(buffer, [3, 100, 1, 4096, 17, 257, 1024]));
    expect(irregular).toBe(singleShot);
  });
});

describe('sha256 streaming wrapper — single-use enforcement', () => {
  test('second digest() call throws', () => {
    const stream = createSha256Stream();
    stream.update(encode('abc'));
    expect(stream.digest()).toBe(ABC_DIGEST);
    expect(() => stream.digest()).toThrow('sha256 stream already finished');
  });

  test('update() after digest() throws', () => {
    const stream = createSha256Stream();
    expect(stream.digest()).toBe(EMPTY_DIGEST);
    expect(() => stream.update(encode('abc'))).toThrow('sha256 stream already finished');
  });
});

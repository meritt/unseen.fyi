import { describe, expect, test } from 'bun:test';

import { OPFS_LOCK_NAME, deriveOpaqueDirName } from '../src/storage/opfs-transfers.ts';

const OPAQUE_NAME_RE = /^[A-Za-z0-9_-]{11}$/u;

const FORBIDDEN_SUBSTRINGS = ['transfers', 'transfer', 'opfs', 'unseen', 'room', 'file', 'lock'];

const zeroSecret = (): Uint8Array<ArrayBuffer> => new Uint8Array(32);

const sequentialSecret = (): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) {
    out[i] = i;
  }
  return out;
};

const flipFirstByte = (input: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(input.length);
  out.set(input);
  out[0] = (out[0] ?? 0) ^ 0x01;
  return out;
};

describe('deriveOpaqueDirName', () => {
  test('is deterministic for a fixed roomSecret', async () => {
    const secret = zeroSecret();
    const first = await deriveOpaqueDirName(secret);
    const second = await deriveOpaqueDirName(secret);
    expect(first).toBe(second);
  });

  test('output matches the opaque 11-char base64url shape for several inputs', async () => {
    for (const secret of [zeroSecret(), sequentialSecret(), flipFirstByte(sequentialSecret())]) {
      const dir = await deriveOpaqueDirName(secret);
      expect(dir).toMatch(OPAQUE_NAME_RE);
    }
  });

  test('two distinct secrets produce two distinct directory names', async () => {
    const a = await deriveOpaqueDirName(zeroSecret());
    const b = await deriveOpaqueDirName(sequentialSecret());
    const c = await deriveOpaqueDirName(flipFirstByte(sequentialSecret()));
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  test('output contains no semantic substring leak', async () => {
    const samples = [
      await deriveOpaqueDirName(zeroSecret()),
      await deriveOpaqueDirName(sequentialSecret()),
      await deriveOpaqueDirName(flipFirstByte(sequentialSecret())),
    ];
    for (const sample of samples) {
      const lower = sample.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });

  test('rejects roomSecret shorter than 32 bytes', () => {
    expect(deriveOpaqueDirName(new Uint8Array(31))).rejects.toThrow(/32 bytes/u);
  });

  test('rejects roomSecret longer than 32 bytes', () => {
    expect(deriveOpaqueDirName(new Uint8Array(33))).rejects.toThrow(/32 bytes/u);
  });
});

describe('OPFS_LOCK_NAME', () => {
  test('matches the opaque 11-char base64url shape', () => {
    expect(OPFS_LOCK_NAME).toMatch(OPAQUE_NAME_RE);
  });

  test('contains no semantic substring leak', () => {
    const lower = OPFS_LOCK_NAME.toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(lower).not.toContain(forbidden);
    }
  });
});

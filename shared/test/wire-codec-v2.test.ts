import { describe, expect, test } from 'bun:test';

import type { Bytes } from '../src/crypto/encoding.ts';
import { MAX_PLAINTEXT_BYTES, MAX_WIRE_BYTES } from '../src/limits.ts';
import { decodeClientFrame, encodeRelay } from '../src/wire/codec.ts';
import { RELAY_KIND_CHUNK, RELAY_KIND_MSG } from '../src/wire/file-frame.ts';
import { MSG_RELAY } from '../src/wire/msg-types.ts';

const makeNonce = (): Bytes => {
  const n = new Uint8Array(12);
  for (let i = 0; i < n.length; i++) {
    n[i] = i * 5 + 2;
  }
  return n;
};

const makeCiphertext = (length: number): Bytes => {
  const ct = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    ct[i] = (i * 17 + 3) & 0xff;
  }
  return ct;
};

const RELAY_KIND_OFFSET = 1;
const RELAY_NONCE_OFFSET = 2;
const RELAY_CT_LEN_OFFSET = 14;
const RELAY_HEADER_LENGTH = 16;

describe('RELAY v2 wire layout', () => {
  test('encode + decode preserves kind=MSG, nonce, and ciphertext', () => {
    const nonce = makeNonce();
    const ciphertext = makeCiphertext(64);
    const buf = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext });
    const decoded = decodeClientFrame(buf);
    expect(decoded?.type).toBe('RELAY');
    if (decoded?.type === 'RELAY') {
      expect(decoded.kind).toBe(RELAY_KIND_MSG);
      expect(decoded.nonce).toEqual(nonce);
      expect(decoded.ciphertext).toEqual(ciphertext);
    }
  });

  test('encode + decode preserves kind=CHUNK', () => {
    const nonce = makeNonce();
    const ciphertext = makeCiphertext(128);
    const buf = encodeRelay({ kind: RELAY_KIND_CHUNK, nonce, ciphertext });
    const decoded = decodeClientFrame(buf);
    expect(decoded?.type).toBe('RELAY');
    if (decoded?.type === 'RELAY') {
      expect(decoded.kind).toBe(RELAY_KIND_CHUNK);
      expect(decoded.nonce).toEqual(nonce);
      expect(decoded.ciphertext).toEqual(ciphertext);
    }
  });

  test('wire bytes at known offsets match the v2 layout', () => {
    const nonce = makeNonce();
    const ciphertext = makeCiphertext(200);
    const buf = encodeRelay({ kind: RELAY_KIND_CHUNK, nonce, ciphertext });
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);

    expect(bytes[0]).toBe(MSG_RELAY);
    expect(bytes[RELAY_KIND_OFFSET]).toBe(RELAY_KIND_CHUNK);
    expect(bytes.slice(RELAY_NONCE_OFFSET, RELAY_NONCE_OFFSET + 12)).toEqual(nonce);
    expect(view.getUint16(RELAY_CT_LEN_OFFSET, true)).toBe(ciphertext.length);
    expect(bytes.slice(RELAY_HEADER_LENGTH, RELAY_HEADER_LENGTH + ciphertext.length)).toEqual(
      ciphertext,
    );
    expect(buf.byteLength).toBe(RELAY_HEADER_LENGTH + ciphertext.length);
  });

  test('decoder rejects invalid kind byte (0x02, 0xFF)', () => {
    const nonce = makeNonce();
    const ciphertext = makeCiphertext(32);
    for (const corruptKind of [0x02, 0xff]) {
      const buf = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext });
      new Uint8Array(buf)[RELAY_KIND_OFFSET] = corruptKind;
      expect(decodeClientFrame(buf)).toBeUndefined();
    }
  });

  test('MAX_WIRE_BYTES exactly equals v2 strict bound', () => {
    const AEAD_TAG_LENGTH = 16;
    const strictBound = 1 + 1 + 12 + 2 + MAX_PLAINTEXT_BYTES + AEAD_TAG_LENGTH;
    expect(strictBound).toBe(8736);
    expect(MAX_WIRE_BYTES).toBe(strictBound);
  });
});

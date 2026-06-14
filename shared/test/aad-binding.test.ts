import { describe, expect, test } from 'bun:test';

import { aesGcmDecrypt, aesGcmEncrypt } from '../src/crypto/aesgcm.ts';
import type { Bytes } from '../src/crypto/encoding.ts';
import { decodeClientFrame, encodeRelay } from '../src/wire/codec.ts';
import {
  aadFor,
  RELAY_KIND_CHUNK,
  RELAY_KIND_MSG,
  type RelayKind,
} from '../src/wire/file-frame.ts';

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

const makeKey = async (): Promise<CryptoKey> =>
  await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

const makeNonce = (): Bytes => new Uint8Array(12);

const assertRejects = async (promise: Promise<unknown>): Promise<void> => {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
};

describe('AAD binding — kind byte is type-confusion immune', () => {
  test('encrypt under aadFor(MSG), decrypt under aadFor(MSG) succeeds', async () => {
    const key = await makeKey();
    const nonce = makeNonce();
    const plaintext = utf8('hello');
    const aad = aadFor(RELAY_KIND_MSG);

    const ciphertext = await aesGcmEncrypt({ key, nonce, aad, plaintext });
    const recovered = await aesGcmDecrypt({ key, nonce, aad, ciphertext });
    expect(recovered).toEqual(plaintext);
  });

  test('encrypt under aadFor(MSG), decrypt under aadFor(CHUNK) fails authentication', async () => {
    const key = await makeKey();
    const nonce = makeNonce();
    const plaintext = utf8('hello');

    const ciphertext = await aesGcmEncrypt({
      key,
      nonce,
      aad: aadFor(RELAY_KIND_MSG),
      plaintext,
    });
    await assertRejects(aesGcmDecrypt({ key, nonce, aad: aadFor(RELAY_KIND_CHUNK), ciphertext }));
  });

  test('encrypt under aadFor(CHUNK), decrypt under aadFor(MSG) fails authentication', async () => {
    const key = await makeKey();
    const nonce = makeNonce();
    const plaintext = utf8('hello');

    const ciphertext = await aesGcmEncrypt({
      key,
      nonce,
      aad: aadFor(RELAY_KIND_CHUNK),
      plaintext,
    });
    await assertRejects(aesGcmDecrypt({ key, nonce, aad: aadFor(RELAY_KIND_MSG), ciphertext }));
  });

  test('wire kind byte tampering: encrypt as MSG, flip kind on wire to CHUNK, decode + decrypt fails', async () => {
    const key = await makeKey();
    const nonce = makeNonce();
    const plaintext = utf8('hello');

    const ciphertext = await aesGcmEncrypt({
      key,
      nonce,
      aad: aadFor(RELAY_KIND_MSG),
      plaintext,
    });

    const frame = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext });

    const wireBytes = new Uint8Array(frame);
    wireBytes[1] = RELAY_KIND_CHUNK;

    const decoded = decodeClientFrame(frame);
    expect(decoded?.type).toBe('RELAY');
    if (decoded?.type !== 'RELAY') {
      throw new Error('precondition: decoded must be a RELAY frame');
    }
    expect(decoded.kind).toBe(RELAY_KIND_CHUNK);

    const wireKind: RelayKind = decoded.kind;
    await assertRejects(
      aesGcmDecrypt({
        key,
        nonce: decoded.nonce,
        aad: aadFor(wireKind),
        ciphertext: decoded.ciphertext,
      }),
    );
  });
});

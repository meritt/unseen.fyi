import { describe, expect, test } from 'bun:test';

import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from '@unseen/shared/crypto/aesgcm.ts';
import { importAesKwKey, unwrapSessionKey, wrapSessionKey } from '@unseen/shared/crypto/aeskw.ts';

import { resumeKeyExtractable } from '../src/domain/passkey.ts';

describe('hardened resume → non-extractable unwrap (integration)', () => {
  test('mode_phase "hardened" maps to a non-extractable resume key', () => {
    expect(resumeKeyExtractable('hardened')).toBe(false);
  });

  test('soft / undefined map to an extractable resume key', () => {
    expect(resumeKeyExtractable('soft')).toBe(true);
    expect(resumeKeyExtractable(undefined)).toBe(true);
  });

  test('unwrapping under the hardened mapping yields a usable, non-exportable key', async () => {
    const sessionKeyRaw = new Uint8Array(32);
    crypto.getRandomValues(sessionKeyRaw);
    const wrapKeyRaw = new Uint8Array(32);
    crypto.getRandomValues(wrapKeyRaw);

    const sessionKey = await importAesGcmKey(sessionKeyRaw, 'extractable');
    const wrapKey = await importAesKwKey(wrapKeyRaw);
    const wrapped = await wrapSessionKey(sessionKey, wrapKey);

    const resumed = await unwrapSessionKey(wrapped, wrapKey, resumeKeyExtractable('hardened'));
    expect(resumed.extractable).toBe(false);
    expect(crypto.subtle.exportKey('raw', resumed)).rejects.toThrow();

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const aad = new TextEncoder().encode('unseen:v1:test');
    const plaintext = new TextEncoder().encode('hardened works');
    const ciphertext = await aesGcmEncrypt({ key: sessionKey, nonce, aad, plaintext });
    const back = await aesGcmDecrypt({ key: resumed, nonce, aad, ciphertext });
    expect(new TextDecoder().decode(back)).toBe('hardened works');
  });
});

import { describe, expect, test } from 'bun:test';

import { aesGcmDecrypt, aesGcmEncrypt } from '../src/crypto/aesgcm.ts';
import { type Bytes, hexDecode, hexEncode } from '../src/crypto/encoding.ts';
import { deriveRekeyedSessionKey, generateRekeyKeyPair } from '../src/crypto/rekey.ts';
import { V1_HKDF, V11_REKEY } from '../src/protocol/test-vectors.ts';

const makeSalt = (seed: number): Bytes => {
  const salt = new Uint8Array(32);
  for (let i = 0; i < salt.length; i++) {
    salt[i] = (seed + i * 11) & 0xff;
  }
  return salt;
};

const emptyBytes = (length: number): Bytes => new Uint8Array(length);

const PKCS8_X25519_PREFIX = hexDecode('302e020100300506032b656e04220420');
const importX25519Priv = async (rawHex: string): Promise<CryptoKey> => {
  const raw = hexDecode(rawHex);
  const der = new Uint8Array(PKCS8_X25519_PREFIX.length + raw.length);
  der.set(PKCS8_X25519_PREFIX, 0);
  der.set(raw, PKCS8_X25519_PREFIX.length);
  return await crypto.subtle.importKey('pkcs8', der, { name: 'X25519' }, false, ['deriveBits']);
};

describe('rekey crypto primitives', () => {
  test('generateRekeyKeyPair returns 32-byte pub + non-extractable priv', async () => {
    const { privateKey, publicKeyRaw } = await generateRekeyKeyPair();
    expect(publicKeyRaw.byteLength).toBe(32);
    expect(privateKey.extractable).toBe(false);
    expect(privateKey.algorithm.name).toBe('X25519');
  });

  test('both peers converge on the same key from independent ECDH', async () => {
    const alice = await generateRekeyKeyPair();
    const bob = await generateRekeyKeyPair();
    const salt = makeSalt(7);

    const aliceMaterial = await deriveRekeyedSessionKey({
      privSelf: alice.privateKey,
      myPubRaw: alice.publicKeyRaw,
      peerPubRaw: bob.publicKeyRaw,
      salt,
    });
    const bobMaterial = await deriveRekeyedSessionKey({
      privSelf: bob.privateKey,
      myPubRaw: bob.publicKeyRaw,
      peerPubRaw: alice.publicKeyRaw,
      salt,
    });

    expect(aliceMaterial.sessionKeyRaw).toEqual(bobMaterial.sessionKeyRaw);
    expect(aliceMaterial.sessionKey.extractable).toBe(false);
    expect(bobMaterial.sessionKey.extractable).toBe(false);
  });

  test('non-extractable by default — cannot exportKey', async () => {
    const alice = await generateRekeyKeyPair();
    const bob = await generateRekeyKeyPair();
    const material = await deriveRekeyedSessionKey({
      privSelf: alice.privateKey,
      myPubRaw: alice.publicKeyRaw,
      peerPubRaw: bob.publicKeyRaw,
      salt: makeSalt(13),
    });
    expect(material.sessionKey.extractable).toBe(false);
    expect(crypto.subtle.exportKey('raw', material.sessionKey)).rejects.toThrow();
  });

  test('derived key encrypts and decrypts AES-GCM round-trip', async () => {
    const alice = await generateRekeyKeyPair();
    const bob = await generateRekeyKeyPair();
    const salt = makeSalt(21);
    const aliceMaterial = await deriveRekeyedSessionKey({
      privSelf: alice.privateKey,
      myPubRaw: alice.publicKeyRaw,
      peerPubRaw: bob.publicKeyRaw,
      salt,
    });
    const bobMaterial = await deriveRekeyedSessionKey({
      privSelf: bob.privateKey,
      myPubRaw: bob.publicKeyRaw,
      peerPubRaw: alice.publicKeyRaw,
      salt,
    });
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const aad = new TextEncoder().encode('unseen:v1:test');
    const plaintext = new TextEncoder().encode('hello rekey');
    const ct = await aesGcmEncrypt({ key: aliceMaterial.sessionKey, nonce, aad, plaintext });
    const pt = await aesGcmDecrypt({ key: bobMaterial.sessionKey, nonce, aad, ciphertext: ct });
    expect(new TextDecoder().decode(pt)).toBe('hello rekey');
  });

  test('different salt domain-separates the derivation', async () => {
    const alice = await generateRekeyKeyPair();
    const bob = await generateRekeyKeyPair();
    const m1 = await deriveRekeyedSessionKey({
      privSelf: alice.privateKey,
      myPubRaw: alice.publicKeyRaw,
      peerPubRaw: bob.publicKeyRaw,
      salt: makeSalt(1),
    });
    const m2 = await deriveRekeyedSessionKey({
      privSelf: alice.privateKey,
      myPubRaw: alice.publicKeyRaw,
      peerPubRaw: bob.publicKeyRaw,
      salt: makeSalt(2),
    });
    expect(m1.sessionKeyRaw).not.toEqual(m2.sessionKeyRaw);
  });

  test('rejects 31-byte and 33-byte peer pubkey', async () => {
    const alice = await generateRekeyKeyPair();
    expect(
      deriveRekeyedSessionKey({
        privSelf: alice.privateKey,
        myPubRaw: alice.publicKeyRaw,
        peerPubRaw: emptyBytes(31),
        salt: makeSalt(0),
      }),
    ).rejects.toThrow();
    expect(
      deriveRekeyedSessionKey({
        privSelf: alice.privateKey,
        myPubRaw: alice.publicKeyRaw,
        peerPubRaw: emptyBytes(33),
        salt: makeSalt(0),
      }),
    ).rejects.toThrow();
  });

  test('reflection guard: rejects peer pubkey equal to own pubkey', async () => {
    const alice = await generateRekeyKeyPair();
    expect(
      deriveRekeyedSessionKey({
        privSelf: alice.privateKey,
        myPubRaw: alice.publicKeyRaw,
        peerPubRaw: alice.publicKeyRaw,
        salt: makeSalt(5),
      }),
    ).rejects.toThrow(/equals own/u);
  });
});

describe('rekey KAT — V11 frozen vector', () => {
  test('production deriveRekeyedSessionKey reproduces the frozen rekeyed_session_key (both directions)', async () => {
    const salt = hexDecode(V1_HKDF.sasAnchorHex);
    const fromInitiator = await deriveRekeyedSessionKey({
      privSelf: await importX25519Priv(V11_REKEY.initiatorPrivHex),
      myPubRaw: hexDecode(V11_REKEY.initiatorPubHex),
      peerPubRaw: hexDecode(V11_REKEY.joinerPubHex),
      salt,
      extractable: true,
    });
    expect(hexEncode(fromInitiator.sessionKeyRaw)).toBe(V11_REKEY.rekeyedSessionKeyHex);

    const fromJoiner = await deriveRekeyedSessionKey({
      privSelf: await importX25519Priv(V11_REKEY.joinerPrivHex),
      myPubRaw: hexDecode(V11_REKEY.joinerPubHex),
      peerPubRaw: hexDecode(V11_REKEY.initiatorPubHex),
      salt,
      extractable: true,
    });
    expect(hexEncode(fromJoiner.sessionKeyRaw)).toBe(V11_REKEY.rekeyedSessionKeyHex);
  });
});

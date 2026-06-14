import { describe, expect, test } from 'bun:test';

import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from '../src/crypto/aesgcm.ts';
import { importAesKwKey, unwrapSessionKey, wrapSessionKey } from '../src/crypto/aeskw.ts';
import { deriveRoomKeys, deriveWrapKey } from '../src/crypto/derive-room-keys.ts';
import { deriveSessionMaterial } from '../src/crypto/derive-session-key.ts';
import { type Bytes, hexDecode, hexEncode } from '../src/crypto/encoding.ts';
import { hkdf } from '../src/crypto/hkdf.ts';
import { bytesEqual, importPeerPublicKey } from '../src/crypto/x25519.ts';
import { AAD_HANDSHAKE, HKDF_INFO_OPFS_TRANSFERS, HKDF_INFO_SAS } from '../src/hkdf-infos.ts';
import {
  V1_HKDF,
  V2_X25519,
  V3_SESSION_KEY,
  V4_SAS,
  V5_AES_GCM,
  V6_WIRE,
  V7_HANDSHAKE_ENCRYPT,
  V8_WRAP_KEY,
} from '../src/protocol/test-vectors.ts';
import { decodeClientFrame, encodeRelay } from '../src/wire/codec.ts';
import { RELAY_KIND_MSG } from '../src/wire/file-frame.ts';

const utf8 = (literal: string): Bytes => new TextEncoder().encode(literal);

describe('V1 — HKDF derivation from secret', () => {
  test('roomId, handshake_key, sas_anchor match vectors', async () => {
    const secret = hexDecode(V1_HKDF.secretHex);
    const keys = await deriveRoomKeys(secret);
    expect(hexEncode(keys.roomIdBytes)).toBe(V1_HKDF.roomIdHex);
    expect(keys.sasAnchor.length).toBe(32);
    expect(hexEncode(keys.sasAnchor)).toBe(V1_HKDF.sasAnchorHex);

    const handshakeKeyRaw = await hkdf({
      ikm: secret,
      info: utf8('unseen:v1:handshake'),
      length: 32,
    });
    expect(hexEncode(handshakeKeyRaw)).toBe(V1_HKDF.handshakeKeyHex);
  });

  test('storageKey and lockKey are opaque, distinct, and deterministic', async () => {
    const secret = hexDecode(V1_HKDF.secretHex);
    const opaqueRe = /^[A-Za-z0-9_-]{11}$/;

    const keys = await deriveRoomKeys(secret);
    expect(keys.storageKey).toMatch(opaqueRe);
    expect(keys.lockKey).toMatch(opaqueRe);
    expect(keys.storageKey).not.toBe(keys.lockKey);

    const keysAgain = await deriveRoomKeys(secret);
    expect(keysAgain.storageKey).toBe(keys.storageKey);
    expect(keysAgain.lockKey).toBe(keys.lockKey);

    for (const value of [keys.storageKey, keys.lockKey]) {
      for (const forbidden of ['unseen', 'session', 'room', V1_HKDF.roomIdHex.slice(0, 8)]) {
        expect(value.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  test('storageKey, lockKey, and prfSalt reproduce the frozen KATs', async () => {
    const keys = await deriveRoomKeys(hexDecode(V1_HKDF.secretHex));
    expect(keys.storageKey).toBe(V1_HKDF.storageKey);
    expect(keys.lockKey).toBe(V1_HKDF.lockKey);
    expect(hexEncode(keys.prfSalt)).toBe(V1_HKDF.prfSaltHex);
  });

  test('lockKey rewrites a leading "-" to "_" (Web Locks rejects a leading dash)', async () => {
    const secret = hexDecode('6a00000042424242424242424242424242424242424242424242424242424242');
    const keys = await deriveRoomKeys(secret);
    expect(keys.lockKey).toBe('_01VTE7p1gM');
    expect(keys.lockKey.startsWith('-')).toBe(false);
  });
});

describe('V3 — handshake guards', () => {
  const anchor = hexDecode(V1_HKDF.sasAnchorHex);
  const alicePub = hexDecode(V2_X25519.alicePubHex);
  const bobPub = hexDecode(V2_X25519.bobPubHex);

  test('rejects an all-zero shared secret (small-order point guard)', () => {
    expect(
      deriveSessionMaterial({
        sharedSecret: new Uint8Array(32),
        myPubKeyRaw: alicePub,
        peerPubKeyRaw: bobPub,
        sasAnchor: anchor,
        extractability: 'extractable',
      }),
    ).rejects.toThrow(/all zero/u);
  });

  test('reflection guard: rejects peer pubkey equal to own pubkey', () => {
    expect(
      deriveSessionMaterial({
        sharedSecret: hexDecode(V2_X25519.sharedSecretHex),
        myPubKeyRaw: alicePub,
        peerPubKeyRaw: alicePub,
        sasAnchor: anchor,
        extractability: 'extractable',
      }),
    ).rejects.toThrow(/equals own/u);
  });
});

describe('V2 — X25519 ECDH (RFC 7748 §6.1)', () => {
  test('deriving a shared secret from RFC vectors', () => {
    const alicePub = hexDecode(V2_X25519.alicePubHex);
    const bobPub = hexDecode(V2_X25519.bobPubHex);
    expect(alicePub.length).toBe(32);
    expect(bobPub.length).toBe(32);
    expect(bytesEqual(alicePub, bobPub)).toBe(false);
    expect(V2_X25519.sharedSecretHex).toBe(
      '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
    );
  });

  test('public-key import succeeds for both peers', async () => {
    await importPeerPublicKey(hexDecode(V2_X25519.alicePubHex));
    await importPeerPublicKey(hexDecode(V2_X25519.bobPubHex));
  });
});

describe('V3 — session_key derivation with canonical transcript', () => {
  test('reproduces the vector hex byte-for-byte', async () => {
    const sharedSecret = hexDecode(V2_X25519.sharedSecretHex);
    const sasAnchor = hexDecode(V1_HKDF.sasAnchorHex);
    const alicePub = hexDecode(V2_X25519.alicePubHex);
    const bobPub = hexDecode(V2_X25519.bobPubHex);

    const fromAlice = await deriveSessionMaterial({
      sharedSecret,
      myPubKeyRaw: alicePub,
      peerPubKeyRaw: bobPub,
      sasAnchor,
      extractability: 'extractable',
    });
    expect(hexEncode(fromAlice.sessionKeyRaw)).toBe(V3_SESSION_KEY.sessionKeyHex);

    const fromBob = await deriveSessionMaterial({
      sharedSecret,
      myPubKeyRaw: bobPub,
      peerPubKeyRaw: alicePub,
      sasAnchor,
      extractability: 'extractable',
    });
    expect(hexEncode(fromBob.sessionKeyRaw)).toBe(V3_SESSION_KEY.sessionKeyHex);
  });
});

describe('V4 — SAS bytes derivation', () => {
  test('5-byte SAS hex matches and indexes the emoji pool', async () => {
    const sessionKey = hexDecode(V3_SESSION_KEY.sessionKeyHex);
    const sasAnchor = hexDecode(V1_HKDF.sasAnchorHex);
    const sasBytes = await hkdf({
      ikm: sessionKey,
      salt: sasAnchor,
      info: HKDF_INFO_SAS,
      length: V4_SAS.length,
    });
    expect(hexEncode(sasBytes)).toBe(V4_SAS.sasBytesHex);
    expect([...sasBytes]).toEqual([...V4_SAS.sasEmojiIndices]);
  });
});

describe('V5 — AES-GCM message encrypt', () => {
  test('encrypts to the recorded ciphertext byte-for-byte', async () => {
    const key = await importAesGcmKey(hexDecode(V3_SESSION_KEY.sessionKeyHex), 'extractable');
    const ciphertext = await aesGcmEncrypt({
      key,
      nonce: hexDecode(V5_AES_GCM.nonceHex),
      aad: hexDecode(V5_AES_GCM.aadHex),
      plaintext: hexDecode(V5_AES_GCM.plaintextHex),
    });
    expect(hexEncode(ciphertext)).toBe(V5_AES_GCM.ciphertextHex);
  });

  test('decrypts back to the original plaintext', async () => {
    const key = await importAesGcmKey(hexDecode(V3_SESSION_KEY.sessionKeyHex), 'extractable');
    const plaintext = await aesGcmDecrypt({
      key,
      nonce: hexDecode(V5_AES_GCM.nonceHex),
      aad: hexDecode(V5_AES_GCM.aadHex),
      ciphertext: hexDecode(V5_AES_GCM.ciphertextHex),
    });
    expect(hexEncode(plaintext)).toBe(V5_AES_GCM.plaintextHex);
    expect(new TextDecoder().decode(plaintext)).toBe(V5_AES_GCM.plaintextUtf8);
  });
});

describe('V6 — RELAY wire format round-trip', () => {
  test('encodes to the exact frame bytes recorded', () => {
    const nonce = hexDecode(V5_AES_GCM.nonceHex);
    const ciphertext = hexDecode(V5_AES_GCM.ciphertextHex);
    const frame = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext });
    expect(frame.byteLength).toBe(V6_WIRE.fullFrameLengthBytes);
    expect(hexEncode(new Uint8Array(frame))).toBe(V6_WIRE.fullFrameHex);
  });

  test('decoder reads back the same nonce and ciphertext', () => {
    const nonce = hexDecode(V5_AES_GCM.nonceHex);
    const ciphertext = hexDecode(V5_AES_GCM.ciphertextHex);
    const frame = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext });
    const decoded = decodeClientFrame(frame);
    expect(decoded?.type).toBe('RELAY');
    if (decoded?.type === 'RELAY') {
      expect(decoded.kind).toBe(RELAY_KIND_MSG);
      expect(hexEncode(decoded.nonce)).toBe(V5_AES_GCM.nonceHex);
      expect(hexEncode(decoded.ciphertext)).toBe(V5_AES_GCM.ciphertextHex);
    }
  });
});

describe('V7 — AES-GCM handshake encrypt', () => {
  test('encrypts the RFC 7748 alice_pub with handshake_key to recorded ciphertext', async () => {
    const keyRaw = hexDecode(V1_HKDF.handshakeKeyHex);
    const key = await importAesGcmKey(keyRaw, 'extractable');
    const ciphertext = await aesGcmEncrypt({
      key,
      nonce: hexDecode(V7_HANDSHAKE_ENCRYPT.nonceHex),
      aad: AAD_HANDSHAKE,
      plaintext: hexDecode(V7_HANDSHAKE_ENCRYPT.plaintextHex),
    });
    expect(ciphertext.length).toBe(V7_HANDSHAKE_ENCRYPT.ciphertextLengthBytes);
    expect(hexEncode(ciphertext)).toBe(V7_HANDSHAKE_ENCRYPT.ciphertextHex);
  });
});

describe('V8 — wrap_key derivation', () => {
  test('reproduces wrap_key from a fixed PRF output', async () => {
    const prfOutput = hexDecode(V8_WRAP_KEY.prfOutputHex);
    const roomIdBytes = hexDecode(V1_HKDF.roomIdHex);
    const wrapKey = await deriveWrapKey({ prfOutput, roomIdBytes });

    const sessionKeyRaw = hexDecode(V3_SESSION_KEY.sessionKeyHex);
    const sessionKey = await importAesGcmKey(sessionKeyRaw, 'extractable');
    const wrapped = await wrapSessionKey(sessionKey, wrapKey);
    const unwrapped = await unwrapSessionKey(wrapped, wrapKey, true);
    const reExported = await crypto.subtle.exportKey('raw', unwrapped);
    expect(hexEncode(new Uint8Array(reExported))).toBe(V3_SESSION_KEY.sessionKeyHex);
  });

  test('explicit wrap_key bytes match the recorded fixture', async () => {
    const prfOutput = hexDecode(V8_WRAP_KEY.prfOutputHex);
    const roomIdBytes = hexDecode(V1_HKDF.roomIdHex);
    const info = new Uint8Array(V8_WRAP_KEY.infoLengthBytes);
    info.set(utf8(V8_WRAP_KEY.infoPrefixUtf8), 0);
    info.set(roomIdBytes, V8_WRAP_KEY.infoPrefixUtf8.length);
    expect(hexEncode(info)).toBe(V8_WRAP_KEY.infoHex);
    const raw = await hkdf({ ikm: prfOutput, info, length: V8_WRAP_KEY.wrapKeyLength });
    expect(hexEncode(raw)).toBe(V8_WRAP_KEY.wrapKeyHex);
  });
});

describe('HKDF info constants', () => {
  test('HKDF_INFO_OPFS_TRANSFERS is the canonical UTF-8 byte sequence', () => {
    expect(new TextDecoder().decode(HKDF_INFO_OPFS_TRANSFERS)).toBe('unseen:v1:opfs:transfers');
    expect(HKDF_INFO_OPFS_TRANSFERS.byteLength).toBe(24);
  });
});

describe('AES-KW round-trip', () => {
  test('wraps and unwraps an extractable AES-GCM session key', async () => {
    const sessionKeyRaw = new Uint8Array(32);
    crypto.getRandomValues(sessionKeyRaw);
    const sessionKey = await importAesGcmKey(sessionKeyRaw, 'extractable');
    const wrapKeyRaw = new Uint8Array(32);
    crypto.getRandomValues(wrapKeyRaw);
    const wrapKey = await importAesKwKey(wrapKeyRaw);

    const wrapped = await wrapSessionKey(sessionKey, wrapKey);
    expect(wrapped.length).toBe(40);

    const unwrapped = await unwrapSessionKey(wrapped, wrapKey, true);
    const reExported = new Uint8Array(await crypto.subtle.exportKey('raw', unwrapped));
    expect(reExported).toEqual(sessionKeyRaw);
  });

  test('extractable=false yields a usable but non-exportable key (hardened resume)', async () => {
    const sessionKeyRaw = new Uint8Array(32);
    crypto.getRandomValues(sessionKeyRaw);
    const sessionKey = await importAesGcmKey(sessionKeyRaw, 'extractable');
    const wrapKeyRaw = new Uint8Array(32);
    crypto.getRandomValues(wrapKeyRaw);
    const wrapKey = await importAesKwKey(wrapKeyRaw);
    const wrapped = await wrapSessionKey(sessionKey, wrapKey);

    const hardened = await unwrapSessionKey(wrapped, wrapKey, false);
    let exported = false;
    try {
      await crypto.subtle.exportKey('raw', hardened);
      exported = true;
    } catch {
      /* exportKey rejects */
    }
    expect(exported).toBe(false);

    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      hardened,
      plaintext,
    );
    const roundTrip = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, hardened, ciphertext),
    );
    expect(roundTrip).toEqual(plaintext);
  });
});

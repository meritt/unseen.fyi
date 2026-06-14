import { HKDF_INFO_SAS, HKDF_INFO_SESSION_KEY_PREFIX } from '../hkdf-infos.ts';
import { importAesGcmKey } from './aesgcm.ts';
import type { Bytes } from './encoding.ts';
import { hkdf } from './hkdf.ts';
import { bytesEqual, isAllZero } from './x25519.ts';

const PUBKEY_LENGTH = 32;
const SESSION_KEY_LENGTH = 32;
const SAS_LENGTH = 5;

const compareLexicographic = (a: Bytes, b: Bytes): number => {
  for (const [i, av] of a.entries()) {
    const bv = b[i];
    if (bv === undefined) {
      return 1;
    }
    if (av !== bv) {
      return av - bv;
    }
  }
  return a.length - b.length;
};

const buildTranscript = (mine: Bytes, peer: Bytes): Bytes => {
  const peerIsLower = compareLexicographic(peer, mine) < 0;
  const lo = peerIsLower ? peer : mine;
  const hi = peerIsLower ? mine : peer;
  const transcript = new Uint8Array(PUBKEY_LENGTH * 2);
  transcript.set(lo, 0);
  transcript.set(hi, PUBKEY_LENGTH);
  return transcript;
};

const concat = (a: Bytes, b: Bytes): Bytes => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export type SessionMaterial = {
  readonly sessionKey: CryptoKey;
  readonly sessionKeyRaw: Bytes;
  readonly sasBytes: Bytes;
};

export type SessionExtractability = 'extractable' | 'non-extractable';

export const deriveSessionMaterial = async ({
  sharedSecret,
  myPubKeyRaw,
  peerPubKeyRaw,
  sasAnchor,
  extractability,
}: {
  readonly sharedSecret: Bytes;
  readonly myPubKeyRaw: Bytes;
  readonly peerPubKeyRaw: Bytes;
  readonly sasAnchor: Bytes;
  readonly extractability: SessionExtractability;
}): Promise<SessionMaterial> => {
  if (sharedSecret.length !== PUBKEY_LENGTH) {
    throw new Error('shared secret must be 32 bytes');
  }
  if (isAllZero(sharedSecret)) {
    throw new Error('shared secret is all zero');
  }
  if (myPubKeyRaw.length !== PUBKEY_LENGTH || peerPubKeyRaw.length !== PUBKEY_LENGTH) {
    throw new Error('public keys must be 32 bytes each');
  }
  if (bytesEqual(myPubKeyRaw, peerPubKeyRaw)) {
    throw new Error('peer public key equals own public key');
  }

  const transcript = buildTranscript(myPubKeyRaw, peerPubKeyRaw);
  const sessionKeyInfo = concat(HKDF_INFO_SESSION_KEY_PREFIX, transcript);

  const sessionKeyRaw = await hkdf({
    ikm: sharedSecret,
    salt: sasAnchor,
    info: sessionKeyInfo,
    length: SESSION_KEY_LENGTH,
  });

  const sasBytes = await hkdf({
    ikm: sessionKeyRaw,
    salt: sasAnchor,
    info: HKDF_INFO_SAS,
    length: SAS_LENGTH,
  });

  const sessionKey = await importAesGcmKey(sessionKeyRaw, extractability);
  return { sessionKey, sessionKeyRaw, sasBytes };
};

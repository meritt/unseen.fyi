import type { Bytes } from './encoding.ts';

export type EphemeralKeyPair = {
  readonly privateKey: CryptoKey;
  readonly publicKeyRaw: Bytes;
};

export const generateEphemeralKeyPair = async (): Promise<EphemeralKeyPair> => {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyRaw: new Uint8Array(raw) };
};

export const importPeerPublicKey = async (raw: Bytes): Promise<CryptoKey> => {
  if (raw.length !== 32) {
    throw new Error('X25519 public key must be 32 bytes');
  }
  return await crypto.subtle.importKey('raw', raw, { name: 'X25519' }, false, []);
};

export const deriveSharedSecret = async (
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<Bytes> => {
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPublicKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
};

export const isAllZero = (bytes: Bytes): boolean => {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return true;
};

export const bytesEqual = (a: Bytes, b: Bytes): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

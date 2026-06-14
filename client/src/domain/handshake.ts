import { aesGcmDecrypt, aesGcmEncrypt } from '@unseen/shared/crypto/aesgcm.ts';
import {
  deriveSessionMaterial,
  type SessionMaterial,
} from '@unseen/shared/crypto/derive-session-key.ts';
import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import {
  deriveSharedSecret,
  type EphemeralKeyPair,
  generateEphemeralKeyPair,
  importPeerPublicKey,
} from '@unseen/shared/crypto/x25519.ts';
import { AAD_HANDSHAKE } from '@unseen/shared/hkdf-infos.ts';

const HANDSHAKE_NONCE_LENGTH = 12;

export const generateLocalHandshake = async (): Promise<EphemeralKeyPair> =>
  await generateEphemeralKeyPair();

export const wrapLocalPublicKey = async ({
  publicKeyRaw,
  handshakeKey,
}: {
  readonly publicKeyRaw: Bytes;
  readonly handshakeKey: CryptoKey;
}): Promise<{ readonly nonce: Bytes; readonly ciphertext: Bytes }> => {
  const nonce: Bytes = crypto.getRandomValues(new Uint8Array(HANDSHAKE_NONCE_LENGTH));
  const ciphertext = await aesGcmEncrypt({
    key: handshakeKey,
    nonce,
    aad: AAD_HANDSHAKE,
    plaintext: publicKeyRaw,
  });
  return { nonce, ciphertext };
};

export const unwrapPeerPublicKey = async ({
  nonce,
  ciphertext,
  handshakeKey,
}: {
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
  readonly handshakeKey: CryptoKey;
}): Promise<Bytes> =>
  await aesGcmDecrypt({
    key: handshakeKey,
    nonce,
    aad: AAD_HANDSHAKE,
    ciphertext,
  });

export const completeHandshake = async ({
  myKeyPair,
  peerPublicKeyRaw,
  sasAnchor,
  extractability,
}: {
  readonly myKeyPair: EphemeralKeyPair;
  readonly peerPublicKeyRaw: Bytes;
  readonly sasAnchor: Bytes;
  readonly extractability: 'extractable' | 'non-extractable';
}): Promise<SessionMaterial> => {
  const peerKey = await importPeerPublicKey(peerPublicKeyRaw);
  const sharedSecret = await deriveSharedSecret(myKeyPair.privateKey, peerKey);
  return await deriveSessionMaterial({
    sharedSecret,
    myPubKeyRaw: myKeyPair.publicKeyRaw,
    peerPubKeyRaw: peerPublicKeyRaw,
    sasAnchor,
    extractability,
  });
};

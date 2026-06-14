import type { Bytes } from './encoding.ts';

export type AesGcmKeyExtractability = 'extractable' | 'non-extractable';

export const importAesGcmKey = async (
  raw: Bytes,
  extractability: AesGcmKeyExtractability,
): Promise<CryptoKey> => {
  if (raw.length !== 32) {
    throw new Error('AES-GCM key must be 32 bytes');
  }
  return await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    extractability === 'extractable',
    ['encrypt', 'decrypt'],
  );
};

export const aesGcmEncrypt = async ({
  key,
  nonce,
  aad,
  plaintext,
}: {
  readonly key: CryptoKey;
  readonly nonce: Bytes;
  readonly aad: Bytes;
  readonly plaintext: Bytes;
}): Promise<Bytes> => {
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    key,
    plaintext,
  );
  return new Uint8Array(encrypted);
};

export const aesGcmDecrypt = async ({
  key,
  nonce,
  aad,
  ciphertext,
}: {
  readonly key: CryptoKey;
  readonly nonce: Bytes;
  readonly aad: Bytes;
  readonly ciphertext: Bytes;
}): Promise<Bytes> => {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    key,
    ciphertext,
  );
  return new Uint8Array(decrypted);
};

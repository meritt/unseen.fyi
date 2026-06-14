import type { Bytes } from './encoding.ts';

export const importAesKwKey = async (raw: Bytes): Promise<CryptoKey> => {
  if (raw.length !== 32) {
    throw new Error('AES-KW key must be 32 bytes');
  }
  return await crypto.subtle.importKey('raw', raw, { name: 'AES-KW' }, false, [
    'wrapKey',
    'unwrapKey',
  ]);
};

export const wrapSessionKey = async (sessionKey: CryptoKey, wrapKey: CryptoKey): Promise<Bytes> => {
  const wrapped = await crypto.subtle.wrapKey('raw', sessionKey, wrapKey, 'AES-KW');
  return new Uint8Array(wrapped);
};

export const unwrapSessionKey = async (
  wrappedSessionKey: Bytes,
  wrapKey: CryptoKey,
  extractable: boolean,
): Promise<CryptoKey> =>
  await crypto.subtle.unwrapKey(
    'raw',
    wrappedSessionKey,
    wrapKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );

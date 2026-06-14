import type { Bytes } from './encoding.ts';

const EMPTY_SALT: Bytes = new Uint8Array(0);

const importKeyMaterial = async (ikm: Bytes): Promise<CryptoKey> =>
  await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);

export const hkdf = async ({
  ikm,
  info,
  length,
  salt = EMPTY_SALT,
}: {
  readonly ikm: Bytes;
  readonly info: Bytes;
  readonly length: number;
  readonly salt?: Bytes;
}): Promise<Bytes> => {
  const baseKey = await importKeyMaterial(ikm);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    length * 8,
  );
  return new Uint8Array(derivedBits);
};

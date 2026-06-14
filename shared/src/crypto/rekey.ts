import { HKDF_INFO_REKEYED_SESSION_KEY } from '../hkdf-infos.ts';
import { importAesGcmKey } from './aesgcm.ts';
import type { Bytes } from './encoding.ts';
import { hkdf } from './hkdf.ts';
import {
  bytesEqual,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  importPeerPublicKey,
  isAllZero,
} from './x25519.ts';

const REKEY_KEY_LENGTH = 32;
const REKEY_PUBKEY_LENGTH = 32;

export type RekeyKeyPair = {
  readonly privateKey: CryptoKey;
  readonly publicKeyRaw: Bytes;
};

export type RekeyMaterial = {
  readonly sessionKey: CryptoKey;
  readonly sessionKeyRaw: Bytes;
};

export const generateRekeyKeyPair = async (): Promise<RekeyKeyPair> =>
  await generateEphemeralKeyPair();

export const deriveRekeyedSessionKey = async ({
  privSelf,
  myPubRaw,
  peerPubRaw,
  salt,
  extractable = false,
}: {
  readonly privSelf: CryptoKey;
  readonly myPubRaw: Bytes;
  readonly peerPubRaw: Bytes;
  readonly salt: Bytes;
  readonly extractable?: boolean;
}): Promise<RekeyMaterial> => {
  if (peerPubRaw.length !== REKEY_PUBKEY_LENGTH || myPubRaw.length !== REKEY_PUBKEY_LENGTH) {
    throw new Error('rekey pubkeys must be 32 bytes');
  }
  if (bytesEqual(myPubRaw, peerPubRaw)) {
    throw new Error('rekey peer pubkey equals own pubkey');
  }
  const peerKey = await importPeerPublicKey(peerPubRaw);
  const shared = await deriveSharedSecret(privSelf, peerKey);
  if (shared.length !== REKEY_PUBKEY_LENGTH) {
    throw new Error('rekey shared secret length unexpected');
  }
  if (isAllZero(shared)) {
    throw new Error('rekey shared secret is all zero');
  }
  const sessionKeyRaw = await hkdf({
    ikm: shared,
    salt,
    info: HKDF_INFO_REKEYED_SESSION_KEY,
    length: REKEY_KEY_LENGTH,
  });
  const sessionKey = await importAesGcmKey(
    sessionKeyRaw,
    extractable ? 'extractable' : 'non-extractable',
  );
  return { sessionKey, sessionKeyRaw };
};

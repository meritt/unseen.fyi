import {
  HKDF_INFO_HANDSHAKE,
  HKDF_INFO_LOCK,
  HKDF_INFO_PRF_SALT,
  HKDF_INFO_ROOM_ID,
  HKDF_INFO_SAS_ANCHOR,
  HKDF_INFO_STORAGE,
  HKDF_INFO_WRAP_PREFIX,
} from '../hkdf-infos.ts';
import { importAesGcmKey } from './aesgcm.ts';
import { importAesKwKey } from './aeskw.ts';
import { type Bytes, base64urlEncode, hexEncode } from './encoding.ts';
import { hkdf } from './hkdf.ts';

const SECRET_LENGTH = 32;
const ROOM_ID_LENGTH = 16;
const KEY_LENGTH = 32;
const STORAGE_NAME_LENGTH = 8;
const LOCK_NAME_LENGTH = 8;
const PRF_SALT_LENGTH = 32;

export type RoomKeys = {
  readonly roomIdBytes: Bytes;
  readonly roomIdHex: string;
  readonly handshakeKey: CryptoKey;
  readonly sasAnchor: Bytes;
  readonly storageKey: string;
  readonly lockKey: string;
  readonly prfSalt: Bytes;
};

export const deriveRoomKeys = async (secret: Bytes): Promise<RoomKeys> => {
  if (secret.length !== SECRET_LENGTH) {
    throw new Error('secret must be 32 bytes');
  }
  const [roomIdBytes, handshakeKeyRaw, sasAnchor, storageBytes, lockBytes, prfSalt] =
    await Promise.all([
      hkdf({ ikm: secret, info: HKDF_INFO_ROOM_ID, length: ROOM_ID_LENGTH }),
      hkdf({ ikm: secret, info: HKDF_INFO_HANDSHAKE, length: KEY_LENGTH }),
      hkdf({ ikm: secret, info: HKDF_INFO_SAS_ANCHOR, length: KEY_LENGTH }),
      hkdf({ ikm: secret, info: HKDF_INFO_STORAGE, length: STORAGE_NAME_LENGTH }),
      hkdf({ ikm: secret, info: HKDF_INFO_LOCK, length: LOCK_NAME_LENGTH }),
      hkdf({ ikm: secret, info: HKDF_INFO_PRF_SALT, length: PRF_SALT_LENGTH }),
    ]);

  const handshakeKey = await importAesGcmKey(handshakeKeyRaw, 'non-extractable');

  const lockKeyEncoded = base64urlEncode(lockBytes);
  const lockKey = lockKeyEncoded.startsWith('-') ? `_${lockKeyEncoded.slice(1)}` : lockKeyEncoded;

  return {
    roomIdBytes,
    roomIdHex: hexEncode(roomIdBytes),
    handshakeKey,
    sasAnchor,
    storageKey: base64urlEncode(storageBytes),
    lockKey,
    prfSalt,
  };
};

const concat = (a: Bytes, b: Bytes): Bytes => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export const deriveWrapKey = async ({
  prfOutput,
  roomIdBytes,
}: {
  readonly prfOutput: Bytes;
  readonly roomIdBytes: Bytes;
}): Promise<CryptoKey> => {
  if (roomIdBytes.length !== ROOM_ID_LENGTH) {
    throw new Error('roomIdBytes must be 16 raw bytes');
  }
  const info = concat(HKDF_INFO_WRAP_PREFIX, roomIdBytes);
  const raw = await hkdf({ ikm: prfOutput, info, length: KEY_LENGTH });
  return await importAesKwKey(raw);
};

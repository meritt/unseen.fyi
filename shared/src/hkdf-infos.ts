import type { Bytes } from './crypto/encoding.ts';

const encoder = new TextEncoder();
const utf8 = (literal: string): Bytes => encoder.encode(literal);

export const HKDF_INFO_ROOM_ID = utf8('unseen:v1:roomId');
export const HKDF_INFO_HANDSHAKE = utf8('unseen:v1:handshake');
export const HKDF_INFO_SAS_ANCHOR = utf8('unseen:v1:sas-anchor');
export const HKDF_INFO_STORAGE = utf8('unseen:v1:storage');
export const HKDF_INFO_LOCK = utf8('unseen:v1:lock');
export const HKDF_INFO_PRF_SALT = utf8('unseen:v1:prf-salt');

export const HKDF_INFO_WRAP_PREFIX = utf8('unseen:v1:wrap');

export const HKDF_INFO_SESSION_KEY_PREFIX = utf8('unseen:v1:session-key');

export const HKDF_INFO_SAS = utf8('unseen:v1:sas');

export const HKDF_INFO_OPFS_TRANSFERS = utf8('unseen:v1:opfs:transfers');

export const AAD_HANDSHAKE = utf8('unseen:v1:handshake');

export const HKDF_INFO_REKEYED_SESSION_KEY = utf8('unseen:v1:rekeyed-session-key');

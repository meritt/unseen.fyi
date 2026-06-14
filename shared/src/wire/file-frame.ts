import type { Bytes } from '../crypto/encoding.ts';

export const RELAY_KIND_MSG = 0x00;
export const RELAY_KIND_CHUNK = 0x01;
export const RELAY_KIND_MODE_UPGRADED = 0x10;
export const RELAY_KIND_REKEY_INIT = 0x11;
export const RELAY_KIND_REKEY_ACK = 0x12;
export const RELAY_KIND_REKEY_DONE = 0x13;

export type RelayKind =
  | typeof RELAY_KIND_MSG
  | typeof RELAY_KIND_CHUNK
  | typeof RELAY_KIND_MODE_UPGRADED
  | typeof RELAY_KIND_REKEY_INIT
  | typeof RELAY_KIND_REKEY_ACK
  | typeof RELAY_KIND_REKEY_DONE;

const ALL_RELAY_KINDS: ReadonlySet<number> = new Set<number>([
  RELAY_KIND_MSG,
  RELAY_KIND_CHUNK,
  RELAY_KIND_MODE_UPGRADED,
  RELAY_KIND_REKEY_INIT,
  RELAY_KIND_REKEY_ACK,
  RELAY_KIND_REKEY_DONE,
]);

export const isRelayKind = (byte: number): byte is RelayKind => ALL_RELAY_KINDS.has(byte);

const AAD_PREFIX = new TextEncoder().encode('unseen:v1:');
const AAD_LENGTH = AAD_PREFIX.byteLength + 1;

export const aadFor = (kind: RelayKind): Bytes => {
  const out = new Uint8Array(AAD_LENGTH);
  out.set(AAD_PREFIX, 0);
  out[AAD_PREFIX.byteLength] = kind;
  return out;
};

export const TID_BYTES = 8;
export const SEQ_BYTES = 4;
export const CHUNK_HEADER_BYTES = TID_BYTES + SEQ_BYTES;

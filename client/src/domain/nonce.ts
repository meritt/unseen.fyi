import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import type { Role } from '@unseen/shared/wire/role.ts';

const NONCE_LENGTH = 12;
const COUNTER_LE_OFFSET = 1;
const RESERVED_OFFSET = 9;
const RESERVED_LENGTH = 3;
const MAX_COUNTER = 2n ** 64n - 1n;

export type DirectionByte = 0x01 | 0x02;

export const directionForRole = (role: Role): DirectionByte => (role === 'initiator' ? 0x01 : 0x02);

export const expectedPeerDirection = (myRole: Role): DirectionByte =>
  myRole === 'initiator' ? 0x02 : 0x01;

export const makeNonce = (direction: DirectionByte, counter: bigint): Bytes => {
  if (counter < 1n || counter > MAX_COUNTER) {
    throw new Error('counter must fit uint64 and be ≥ 1');
  }
  const nonce = new Uint8Array(NONCE_LENGTH);
  nonce[0] = direction;
  const view = new DataView(nonce.buffer);
  view.setBigUint64(COUNTER_LE_OFFSET, counter, true);
  return nonce;
};

export type NonceFields = {
  readonly direction: number;
  readonly counter: bigint;
  readonly reservedAllZero: boolean;
};

export const parseNonce = (nonce: Bytes): NonceFields => {
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error('nonce must be 12 bytes');
  }
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const direction = view.getUint8(0);
  const counter = view.getBigUint64(COUNTER_LE_OFFSET, true);
  let reservedAllZero = true;
  for (let i = 0; i < RESERVED_LENGTH; i++) {
    if (nonce[RESERVED_OFFSET + i] !== 0) {
      reservedAllZero = false;
      break;
    }
  }
  return { direction, counter, reservedAllZero };
};

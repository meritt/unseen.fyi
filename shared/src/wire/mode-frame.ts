import type { Bytes } from '../crypto/encoding.ts';

const REKEY_PUBKEY_LENGTH = 32;

export const encodeModeUpgradedPayload = (): Bytes => new Uint8Array(0);

export const encodeRekeyInitPayload = (newPub: Bytes): Bytes => {
  if (newPub.length !== REKEY_PUBKEY_LENGTH) {
    throw new Error('rekey_init pubkey must be 32 bytes');
  }
  return new Uint8Array(newPub);
};

export const encodeRekeyAckPayload = (newPub: Bytes): Bytes => {
  if (newPub.length !== REKEY_PUBKEY_LENGTH) {
    throw new Error('rekey_ack pubkey must be 32 bytes');
  }
  return new Uint8Array(newPub);
};

export const encodeRekeyDonePayload = (): Bytes => new Uint8Array(0);

export const decodeModeUpgradedPayload = (payload: Bytes): boolean => payload.length === 0;

export const decodeRekeyPubkeyPayload = (payload: Bytes): Bytes | undefined =>
  payload.length === REKEY_PUBKEY_LENGTH ? new Uint8Array(payload) : undefined;

export const decodeRekeyDonePayload = (payload: Bytes): boolean => payload.length === 0;

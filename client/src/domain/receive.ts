import { aesGcmDecrypt } from '@unseen/shared/crypto/aesgcm.ts';
import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { type PlaintextEnvelope, decodeEnvelope } from '@unseen/shared/wire/envelope.ts';
import {
  RELAY_KIND_CHUNK,
  RELAY_KIND_MSG,
  type RelayKind,
  aadFor,
} from '@unseen/shared/wire/file-frame.ts';
import type { Role } from '@unseen/shared/wire/role.ts';

import { expectedPeerDirection, parseNonce } from './nonce.ts';

export type CounterMode = 'strict' | 'first-gap-allowed';

export type ReceiveState = {
  counterRecv: bigint;
  readonly role: Role;
  readonly sessionKey: CryptoKey;
  readonly persistCounterRecv?: (counter: bigint) => void;
};

export type RelayFrameResult =
  | { readonly status: 'ok'; readonly plaintext: Bytes; readonly counter: bigint }
  | { readonly status: 'invalid_direction' }
  | { readonly status: 'invalid_reserved' }
  | { readonly status: 'counter_gap' }
  | { readonly status: 'decrypt_failed' };

export const validateAndDecryptFrame = async ({
  state,
  kind,
  nonce,
  ciphertext,
  mode,
}: {
  readonly state: Pick<ReceiveState, 'counterRecv' | 'role' | 'sessionKey'>;
  readonly kind: RelayKind;
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
  readonly mode: CounterMode;
}): Promise<RelayFrameResult> => {
  const fields = parseNonce(nonce);
  if (fields.direction !== expectedPeerDirection(state.role)) {
    return { status: 'invalid_direction' };
  }
  if (!fields.reservedAllZero) {
    return { status: 'invalid_reserved' };
  }
  if (mode === 'strict') {
    if (fields.counter !== state.counterRecv + 1n) {
      return { status: 'counter_gap' };
    }
  } else if (fields.counter <= state.counterRecv) {
    return { status: 'counter_gap' };
  }
  let plaintext: Bytes;
  try {
    plaintext = await aesGcmDecrypt({
      key: state.sessionKey,
      nonce,
      aad: aadFor(kind),
      ciphertext,
    });
  } catch {
    return { status: 'decrypt_failed' };
  }
  return { status: 'ok', plaintext, counter: fields.counter };
};

export type ReceiveResult =
  | { readonly status: 'ok'; readonly envelope: PlaintextEnvelope; readonly counter: bigint }
  | { readonly status: 'invalid_direction' }
  | { readonly status: 'invalid_reserved' }
  | { readonly status: 'counter_gap' }
  | { readonly status: 'decrypt_failed' }
  | { readonly status: 'malformed_envelope' };

export const decryptIncoming = async (
  state: ReceiveState,
  nonce: Bytes,
  ciphertext: Bytes,
  mode: CounterMode = 'strict',
): Promise<ReceiveResult> => {
  const frame = await validateAndDecryptFrame({
    state,
    kind: RELAY_KIND_MSG,
    nonce,
    ciphertext,
    mode,
  });
  if (frame.status !== 'ok') {
    return frame;
  }
  try {
    const envelope = decodeEnvelope(frame.plaintext);
    state.counterRecv = frame.counter;
    state.persistCounterRecv?.(frame.counter);
    return { status: 'ok', envelope, counter: frame.counter };
  } catch {
    return { status: 'malformed_envelope' };
  }
};

export const decryptChunkFrame = async (
  state: ReceiveState,
  nonce: Bytes,
  ciphertext: Bytes,
  mode: CounterMode = 'strict',
): Promise<RelayFrameResult> => {
  const frame = await validateAndDecryptFrame({
    state,
    kind: RELAY_KIND_CHUNK,
    nonce,
    ciphertext,
    mode,
  });
  if (frame.status === 'ok') {
    state.counterRecv = frame.counter;
  }
  return frame;
};

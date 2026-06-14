import { aesGcmEncrypt } from '@unseen/shared/crypto/aesgcm.ts';
import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { encodeRelay } from '@unseen/shared/wire/codec.ts';
import { RELAY_KIND_CHUNK, type RelayKind, aadFor } from '@unseen/shared/wire/file-frame.ts';
import type { Role } from '@unseen/shared/wire/role.ts';

import { canAttemptSend } from '../transport/send-pipeline.ts';
import { directionForRole, makeNonce } from './nonce.ts';

export const RESERVATION_BLOCK_TEXT = 1n;
export const RESERVATION_BLOCK_CHUNK = 64n;

export type SendState = {
  counterCommitted: bigint;
  counterReserved: bigint;
  readonly role: Role;
  readonly sessionKey: CryptoKey;
  readonly persistCounterReserved?: (counter: bigint) => void;
};

const blockSizeFor = (kind: RelayKind): bigint =>
  kind === RELAY_KIND_CHUNK ? RESERVATION_BLOCK_CHUNK : RESERVATION_BLOCK_TEXT;

export const allocateCounter = (state: SendState, kind: RelayKind): bigint => {
  if (state.counterCommitted >= state.counterReserved) {
    const block = blockSizeFor(kind);
    const nextReserved = state.counterReserved + block;
    state.persistCounterReserved?.(nextReserved);
    state.counterReserved = nextReserved;
  }
  state.counterCommitted += 1n;
  return state.counterCommitted;
};

export const encryptRelayFrame = async (
  state: Pick<SendState, 'role' | 'sessionKey'>,
  kind: RelayKind,
  counter: bigint,
  plaintext: Bytes,
): Promise<ArrayBuffer> => {
  const nonce: Bytes = makeNonce(directionForRole(state.role), counter);
  const ciphertext = await aesGcmEncrypt({
    key: state.sessionKey,
    nonce,
    aad: aadFor(kind),
    plaintext,
  });
  return encodeRelay({ kind, nonce, ciphertext });
};

export type RelaySendConnection = {
  readonly socket: WebSocket;
  readonly send: (frame: ArrayBuffer) => void;
};

export type RelaySendTask = {
  readonly isTerminated: () => boolean;
  readonly getConnection: () => RelaySendConnection | undefined;
  readonly terminate: (reason: string) => void;
  readonly allocate: (kind: RelayKind) => bigint;
  readonly keys: Pick<SendState, 'role' | 'sessionKey'>;
  readonly kind: RelayKind;
  readonly plaintext: Bytes;
  readonly encryptFailReason: string;
};

export const runRelaySendTask = async (task: RelaySendTask): Promise<boolean> => {
  if (task.isTerminated()) {
    return false;
  }
  const connection = task.getConnection();
  if (connection === undefined) {
    return false;
  }
  if (canAttemptSend(connection.socket) !== 'ok') {
    return false;
  }
  let frame: ArrayBuffer;
  try {
    const counter = task.allocate(task.kind);
    frame = await encryptRelayFrame(task.keys, task.kind, counter, task.plaintext);
  } catch {
    task.terminate(task.encryptFailReason);
    return false;
  }
  try {
    connection.send(frame);
  } catch {
    task.terminate('send_failed');
    return false;
  }
  return true;
};

export type SendSerializer = <T>(task: () => Promise<T>) => Promise<T>;

export const createSendSerializer = (): SendSerializer => {
  let chain: Promise<unknown> = Promise.resolve();
  const run = async <T>(prev: Promise<unknown>, task: () => Promise<T>): Promise<T> => {
    try {
      await prev;
    } catch {
      /* prior task settled */
    }
    return await task();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const result = run(chain, task);
    chain = result;
    return await result;
  };
};

import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { type PlaintextEnvelope, encodeEnvelope } from '@unseen/shared/wire/envelope.ts';
import { RELAY_KIND_CHUNK, RELAY_KIND_MSG } from '@unseen/shared/wire/file-frame.ts';

import { allocateCounter, encryptRelayFrame, type SendState } from '../../src/domain/send.ts';

// test-only: never allocate + encrypt together in src outside the send serializer — it reuses a counter, and a nonce

export const reserveCounterAndEncrypt = async (
  state: SendState,
  envelope: PlaintextEnvelope,
): Promise<ArrayBuffer> => {
  const counter = allocateCounter(state, RELAY_KIND_MSG);
  return await encryptRelayFrame(state, RELAY_KIND_MSG, counter, encodeEnvelope(envelope));
};

export const reserveChunkAndEncrypt = async (
  state: SendState,
  plaintext: Bytes,
): Promise<ArrayBuffer> => {
  const counter = allocateCounter(state, RELAY_KIND_CHUNK);
  return await encryptRelayFrame(state, RELAY_KIND_CHUNK, counter, plaintext);
};

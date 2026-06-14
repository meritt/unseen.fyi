import { describe, expect, test } from 'bun:test';

import { importAesGcmKey } from '@unseen/shared/crypto/aesgcm.ts';
import { decodeClientFrame } from '@unseen/shared/wire/codec.ts';
import type { PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';

import { decryptChunkFrame, decryptIncoming, type ReceiveState } from '../src/domain/receive.ts';
import type { SendState } from '../src/domain/send.ts';
import { reserveChunkAndEncrypt, reserveCounterAndEncrypt } from './_helpers/reserve-encrypt.ts';

const FIXED_ISO = '2026-05-14T00:00:00.000Z';

const SHARED_KEY_BYTES = 32;

const msgEnvelope = (body: string): PlaintextEnvelope => ({
  kind: 'msg',
  body,
  t: FIXED_ISO,
});

const setupKey = async (): Promise<CryptoKey> => {
  const raw = new Uint8Array(SHARED_KEY_BYTES);
  crypto.getRandomValues(raw);
  return await importAesGcmKey(raw, 'extractable');
};

describe('client send / receive round-trip', () => {
  test('initiator → joiner round-trip preserves body and counters', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };
    const receiver: ReceiveState = { counterRecv: 0n, role: 'joiner', sessionKey };

    const frame = await reserveCounterAndEncrypt(sender, msgEnvelope('hello world'));
    expect(sender.counterCommitted).toBe(1n);

    const decoded = decodeClientFrame(frame);
    if (decoded?.type !== 'RELAY') {
      throw new Error('expected RELAY');
    }
    const result = await decryptIncoming(receiver, decoded.nonce, decoded.ciphertext);
    if (result.status !== 'ok') {
      throw new Error(`expected ok, got ${result.status}`);
    }
    if (result.envelope.kind !== 'msg') {
      throw new Error(`expected msg envelope, got ${result.envelope.kind}`);
    }
    expect(result.envelope.body).toBe('hello world');
    expect(receiver.counterRecv).toBe(1n);
  });

  test('counter gap (replay attempt) is rejected and state is not advanced', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };
    const receiver: ReceiveState = { counterRecv: 0n, role: 'joiner', sessionKey };

    const frameA = await reserveCounterAndEncrypt(sender, msgEnvelope('first'));
    const decodedA = decodeClientFrame(frameA);
    if (decodedA?.type !== 'RELAY') {
      throw new Error('expected RELAY');
    }
    const okA = await decryptIncoming(receiver, decodedA.nonce, decodedA.ciphertext);
    expect(okA.status).toBe('ok');

    const replay = await decryptIncoming(receiver, decodedA.nonce, decodedA.ciphertext);
    expect(replay.status).toBe('counter_gap');
    expect(receiver.counterRecv).toBe(1n);
  });

  test('wrong direction byte is rejected', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };
    const wrongRoleReceiver: ReceiveState = {
      counterRecv: 0n,
      role: 'initiator',
      sessionKey,
    };

    const frame = await reserveCounterAndEncrypt(sender, msgEnvelope('x'));
    const decoded = decodeClientFrame(frame);
    if (decoded?.type !== 'RELAY') {
      throw new Error('expected RELAY');
    }
    const result = await decryptIncoming(wrongRoleReceiver, decoded.nonce, decoded.ciphertext);
    expect(result.status).toBe('invalid_direction');
  });

  test('tampered ciphertext fails AEAD decrypt', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };
    const receiver: ReceiveState = { counterRecv: 0n, role: 'joiner', sessionKey };

    const frame = await reserveCounterAndEncrypt(sender, msgEnvelope('x'));
    const decoded = decodeClientFrame(frame);
    if (decoded?.type !== 'RELAY') {
      throw new Error('expected RELAY');
    }
    const tampered = new Uint8Array(decoded.ciphertext);
    tampered.set([(tampered[0] ?? 0) ^ 0x01], 0);
    const result = await decryptIncoming(receiver, decoded.nonce, tampered);
    expect(result.status).toBe('decrypt_failed');
  });

  test('chunk frame after a resume tolerates one forward counter jump, then stays strict', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };
    const receiver: ReceiveState = { counterRecv: 0n, role: 'joiner', sessionKey };

    const asRelay = (
      frame: ArrayBuffer,
    ): Extract<ReturnType<typeof decodeClientFrame>, { type: 'RELAY' }> => {
      const decoded = decodeClientFrame(frame);
      if (decoded?.type !== 'RELAY') {
        throw new Error('expected RELAY');
      }
      return decoded;
    };

    const c1 = asRelay(await reserveChunkAndEncrypt(sender, new Uint8Array([1])));
    const c1Result = await decryptChunkFrame(receiver, c1.nonce, c1.ciphertext);
    expect(c1Result.status).toBe('ok');
    expect(receiver.counterRecv).toBe(1n);

    await reserveChunkAndEncrypt(sender, new Uint8Array([2]));
    await reserveChunkAndEncrypt(sender, new Uint8Array([3]));
    const c4 = asRelay(await reserveChunkAndEncrypt(sender, new Uint8Array([4])));

    const gap = await decryptChunkFrame(receiver, c4.nonce, c4.ciphertext, 'strict');
    expect(gap.status).toBe('counter_gap');
    expect(receiver.counterRecv).toBe(1n);

    const jumped = await decryptChunkFrame(receiver, c4.nonce, c4.ciphertext, 'first-gap-allowed');
    expect(jumped.status).toBe('ok');
    expect(receiver.counterRecv).toBe(4n);

    const c5 = asRelay(await reserveChunkAndEncrypt(sender, new Uint8Array([5])));
    const c5Result = await decryptChunkFrame(receiver, c5.nonce, c5.ciphertext);
    expect(c5Result.status).toBe('ok');
    expect(receiver.counterRecv).toBe(5n);
  });
});

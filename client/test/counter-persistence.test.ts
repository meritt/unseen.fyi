import { describe, expect, test } from 'bun:test';

import { importAesGcmKey } from '@unseen/shared/crypto/aesgcm.ts';
import { decodeClientFrame } from '@unseen/shared/wire/codec.ts';
import type { PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';

import { decryptIncoming, type ReceiveState } from '../src/domain/receive.ts';
import type { SendState } from '../src/domain/send.ts';
import { reserveCounterAndEncrypt } from './_helpers/reserve-encrypt.ts';

const SHARED_KEY_BYTES = 32;
const FIXED_ISO = '2026-05-14T00:00:00.000Z';
const RESUME_ID = '0123456789abcdef';

const msgEnvelope = (body: string): PlaintextEnvelope => ({
  kind: 'msg',
  body,
  t: FIXED_ISO,
});

const resumeEnvelope = (): PlaintextEnvelope => ({ kind: 'resume', _id: RESUME_ID });

const setupKey = async (): Promise<CryptoKey> => {
  const raw = new Uint8Array(SHARED_KEY_BYTES);
  crypto.getRandomValues(raw);
  return await importAesGcmKey(raw, 'extractable');
};

describe('counter persistence (PRF-mode invariant)', () => {
  test('persistCounterReserved is called before encrypt for every text send (block=1)', async () => {
    const sessionKey = await setupKey();
    const calls: bigint[] = [];
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
      persistCounterReserved: (counter): void => {
        calls.push(counter);
      },
    };
    await reserveCounterAndEncrypt(sender, msgEnvelope('a'));
    await reserveCounterAndEncrypt(sender, msgEnvelope('b'));
    await reserveCounterAndEncrypt(sender, msgEnvelope('c'));
    expect(calls).toEqual([1n, 2n, 3n]);
    expect(sender.counterCommitted).toBe(3n);
    expect(sender.counterReserved).toBe(3n);
  });

  test('persistCounterRecv is called on every accepted frame', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };
    const calls: bigint[] = [];
    const receiver: ReceiveState = {
      counterRecv: 0n,
      role: 'joiner',
      sessionKey,
      persistCounterRecv: (counter): void => {
        calls.push(counter);
      },
    };

    for (let i = 0; i < 3; i++) {
      const frame = await reserveCounterAndEncrypt(sender, msgEnvelope(`payload-${String(i)}`));
      const decoded = decodeClientFrame(frame);
      if (decoded?.type !== 'RELAY') {
        throw new Error('expected RELAY');
      }
      const result = await decryptIncoming(receiver, decoded.nonce, decoded.ciphertext);
      expect(result.status).toBe('ok');
    }

    expect(calls).toEqual([1n, 2n, 3n]);
  });

  test('persist hook throw aborts the send and leaves both counters unchanged (atomicity)', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
      persistCounterReserved: (): void => {
        throw new Error('quota_exceeded');
      },
    };
    let thrown: unknown;
    try {
      await reserveCounterAndEncrypt(sender, msgEnvelope('x'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(sender.counterCommitted).toBe(0n);
    expect(sender.counterReserved).toBe(0n);
  });

  test('first-gap-allowed mode accepts counter > recv on a single frame, strict thereafter', async () => {
    const sessionKey = await setupKey();
    const sender: SendState = {
      counterCommitted: 5n,
      counterReserved: 5n,
      role: 'initiator',
      sessionKey,
    };
    const receiver: ReceiveState = {
      counterRecv: 2n,
      role: 'joiner',
      sessionKey,
    };

    const frame = await reserveCounterAndEncrypt(sender, resumeEnvelope());
    const decoded = decodeClientFrame(frame);
    if (decoded?.type !== 'RELAY') {
      throw new Error('expected RELAY');
    }
    const result = await decryptIncoming(
      receiver,
      decoded.nonce,
      decoded.ciphertext,
      'first-gap-allowed',
    );
    expect(result.status).toBe('ok');
    expect(receiver.counterRecv).toBe(6n);

    const next = await reserveCounterAndEncrypt(sender, msgEnvelope('ok'));
    const decodedNext = decodeClientFrame(next);
    if (decodedNext?.type !== 'RELAY') {
      throw new Error('expected RELAY');
    }
    const resultNext = await decryptIncoming(receiver, decodedNext.nonce, decodedNext.ciphertext);
    expect(resultNext.status).toBe('ok');
    expect(receiver.counterRecv).toBe(7n);
  });
});

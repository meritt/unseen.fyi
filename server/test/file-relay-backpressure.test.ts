import { afterEach, describe, expect, test } from 'bun:test';
import { connect as netConnect, type Socket } from 'node:net';

import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { PEER_BUFFER_CAP_BYTES } from '@unseen/shared/limits.ts';
import { decodeServerFrame, encodeHello, encodeRelay } from '@unseen/shared/wire/codec.ts';
import { RELAY_KIND_CHUNK } from '@unseen/shared/wire/file-frame.ts';
import { MSG_RELAY } from '@unseen/shared/wire/msg-types.ts';

import type { Config } from '../src/config.ts';
import { WS_CLOSE_INTERNAL } from '../src/room/send.ts';
import { startServer, type StartedServer } from '../src/server.ts';
import { openPeer, type ServerEvent, TEST_ORIGIN, testConfig } from './_helpers/harness.ts';

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (s) => await s.stop()));
});

const launch = (config: Config): StartedServer => {
  const started = startServer(config);
  servers.push(started);
  return started;
};

const makeRoomId = (seed: number): Bytes => {
  const id = new Uint8Array(16);
  for (let i = 0; i < id.length; i++) {
    id[i] = (seed * 11 + i * 5) & 0xff;
  }
  return id;
};

const expectFrame = (event: ServerEvent): ArrayBuffer => {
  if (event.kind !== 'frame') {
    throw new Error(`expected frame, got ${event.kind}`);
  }
  return event.data;
};

describe('file relay — per-connection RELAY rate limit', () => {
  test('alice exceeding relayBucket gets RATE_LIMITED on the over-budget frame', async () => {
    const server = launch(
      testConfig({
        relayBucket: { limit: 5, refillPerSec: 0.001 },
      }),
    );
    const roomId = makeRoomId(1);
    const alice = await openPeer(server.url);
    const bob = await openPeer(server.url);

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');

    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    const bobAck = expectFrame(await bob.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(bobAck)).toEqual({ type: 'ACK', role: 'joiner' });
    await alice.waitFor((event) => event.kind === 'frame');

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const ciphertext = new Uint8Array(32);
    crypto.getRandomValues(ciphertext);

    for (let i = 0; i < 6; i++) {
      const frame = encodeRelay({ kind: RELAY_KIND_CHUNK, nonce, ciphertext });
      alice.ws.send(frame);
    }

    const aliceError = expectFrame(
      await alice.waitFor((event) => {
        if (event.kind !== 'frame') {
          return false;
        }
        const decoded = decodeServerFrame(event.data);
        return decoded?.type === 'ERROR' && decoded.code === 'RATE_LIMITED';
      }),
    );
    expect(decodeServerFrame(aliceError)).toEqual({ type: 'ERROR', code: 'RATE_LIMITED' });

    const bobReceived = bob.events.filter(
      (event) => event.kind === 'frame' && new Uint8Array(event.data)[0] === MSG_RELAY,
    ).length;
    expect(bobReceived).toBe(5);

    const aliceClose = await alice.waitFor((event) => event.kind === 'close');
    expect(aliceClose.kind).toBe('close');

    alice.close();
    bob.close();
  });
});

const RELAY_CIPHERTEXT_BYTES = 8192;
const FRAMES_PER_BURST = 64;

const maskedBinaryFrame = (payload: Uint8Array): Uint8Array => {
  if (payload.byteLength >= 126) {
    throw new Error('test frame needs a 7-bit payload length');
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const frame = new Uint8Array(2 + mask.byteLength + payload.byteLength);
  frame[0] = 0x82;
  frame[1] = 0x80 | payload.byteLength;
  frame.set(mask, 2);
  for (let i = 0; i < payload.byteLength; i++) {
    frame[6 + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return frame;
};

const openStalledPeer = async (url: string): Promise<Socket> => {
  const { hostname, port, pathname } = new URL(url);
  const socket = netConnect({ host: hostname, port: Number(port) });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const upgraded = new Promise<void>((resolve) => {
    socket.once('data', () => resolve());
  });
  socket.write(
    [
      `GET ${pathname} HTTP/1.1`,
      `Host: ${hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.getRandomValues(new Uint8Array(16)).toBase64()}`,
      'Sec-WebSocket-Version: 13',
      `Origin: ${TEST_ORIGIN}`,
      '',
      '',
    ].join('\r\n'),
  );
  await upgraded;
  socket.pause();
  return socket;
};

describe('file relay — slow-receiver peer-buffer cap', () => {
  test('a peer that stops reading is dropped once its buffer passes the cap', async () => {
    const server = launch(testConfig({ relayBucket: { limit: 100_000, refillPerSec: 100_000 } }));
    const roomId = makeRoomId(2);
    const alice = await openPeer(server.url);
    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');

    const stalled = await openStalledPeer(server.url);
    try {
      stalled.write(maskedBinaryFrame(new Uint8Array(encodeHello({ roomId, intent: 'join' }))));
      await alice.waitFor(
        (event) => event.kind === 'frame' && decodeServerFrame(event.data)?.type === 'PEER_JOINED',
      );

      const frame = encodeRelay({
        kind: RELAY_KIND_CHUNK,
        nonce: new Uint8Array(12),
        ciphertext: new Uint8Array(RELAY_CIPHERTEXT_BYTES),
      });
      let sentBytes = 0;
      while (sentBytes < 4 * PEER_BUFFER_CAP_BYTES && alice.ws.readyState === WebSocket.OPEN) {
        for (let i = 0; i < FRAMES_PER_BURST; i++) {
          alice.ws.send(frame);
        }
        sentBytes += FRAMES_PER_BURST * frame.byteLength;
        await Bun.sleep(1);
      }

      const aliceClose = await alice.waitFor((event) => event.kind === 'close', 10_000);
      expect(aliceClose).toEqual({
        kind: 'close',
        code: WS_CLOSE_INTERNAL,
        reason: 'peer_buffer_overflow',
      });
    } finally {
      stalled.destroy();
      alice.close();
    }
  }, 20_000);
});

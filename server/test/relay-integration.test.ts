import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type Bytes, hexEncode } from '@unseen/shared/crypto/encoding.ts';
import {
  decodeServerFrame,
  encodeHandshake,
  encodeHello,
  encodeRelay,
} from '@unseen/shared/wire/codec.ts';
import { RELAY_KIND_CHUNK, RELAY_KIND_MSG } from '@unseen/shared/wire/file-frame.ts';

import type { Config } from '../src/config.ts';
import { DEFAULT_RELAY_BUCKET } from '../src/ratelimit/relay-bucket.ts';
import { startServer, type StartedServer } from '../src/server.ts';

const TEST_ORIGIN = 'http://localhost';

const RELAXED_IP_LIMITS = {
  connect: { limit: 1000, refillPerSec: 1000 },
  newRoom: { limit: 1000, refillPerSec: 1000 },
  joinRoom: { limit: 1000, refillPerSec: 1000 },
  health: { limit: 1000, refillPerSec: 1000 },
};

const testConfig = (overrides: Partial<Config> = {}): Config => ({
  port: 0,
  host: '127.0.0.1',
  trustedProxyHeader: undefined,
  allowedOrigins: [TEST_ORIGIN],
  ipLimits: RELAXED_IP_LIMITS,
  relayBucket: DEFAULT_RELAY_BUCKET,
  clientDistDir: '/tmp',
  metricsEnabled: false,
  metricsUser: undefined,
  metricsPass: undefined,
  metricsBind: '127.0.0.1',
  metricsPort: 0,
  gracePeriodMs: 300_000,
  sweepIntervalMs: 30_000,
  keepaliveIntervalMs: 20_000,
  ...overrides,
});

let started: StartedServer;

beforeAll(() => {
  started = startServer(testConfig());
});

afterAll(async () => {
  await started.stop();
});

type ServerEvent =
  | { kind: 'frame'; data: ArrayBuffer }
  | { kind: 'close'; code: number; reason: string };

type Client = {
  readonly ws: WebSocket;
  readonly events: ServerEvent[];
  waitFor: (predicate: (event: ServerEvent) => boolean, timeoutMs?: number) => Promise<ServerEvent>;
  close: () => void;
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const openClient = async (): Promise<Client> => {
  const WsCtor = WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new WsCtor(started.url, { headers: { Origin: TEST_ORIGIN } });
  ws.binaryType = 'arraybuffer';

  const events: ServerEvent[] = [];

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      events.push({ kind: 'frame', data: event.data });
    }
  });
  ws.addEventListener('close', (event) => {
    events.push({ kind: 'close', code: event.code, reason: event.reason });
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });

  const waitFor = async (
    predicate: (event: ServerEvent) => boolean,
    timeoutMs = 1000,
  ): Promise<ServerEvent> => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const found = events.find((event) => predicate(event));
      if (found !== undefined) {
        return found;
      }
      await sleep(20);
    }
    throw new Error('waitFor timed out');
  };

  return {
    ws,
    events,
    waitFor,
    close: (): void => ws.close(),
  };
};

const makeRoomId = (seed: number): Bytes => {
  const id = new Uint8Array(16);
  for (let i = 0; i < id.length; i++) {
    id[i] = (seed + i * 7) & 0xff;
  }
  return id;
};

const expectFrame = (event: ServerEvent): ArrayBuffer => {
  if (event.kind !== 'frame') {
    throw new Error(`expected frame, got ${event.kind}`);
  }
  return event.data;
};

const expectClose = (event: ServerEvent): { code: number; reason: string } => {
  if (event.kind !== 'close') {
    throw new Error(`expected close, got ${event.kind}`);
  }
  return { code: event.code, reason: event.reason };
};

describe('relay happy path', () => {
  test('two clients exchange HANDSHAKE and RELAY byte-identical via opaque forward', async () => {
    const roomId = makeRoomId(1);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    const aliceAck = expectFrame(await alice.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(aliceAck)).toEqual({ type: 'ACK', role: 'initiator' });

    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    const bobAck = expectFrame(await bob.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(bobAck)).toEqual({ type: 'ACK', role: 'joiner' });

    const alicePeerJoinedRaw = await alice.waitFor(
      (event) => event.kind === 'frame' && event.data !== aliceAck,
    );
    expect(decodeServerFrame(expectFrame(alicePeerJoinedRaw))).toEqual({ type: 'PEER_JOINED' });

    const nonce = new Uint8Array(12);
    nonce[0] = 0x01;
    nonce[1] = 0x01;
    const ciphertext = new Uint8Array(48);
    crypto.getRandomValues(ciphertext);
    const aliceHandshake = encodeHandshake(nonce, ciphertext);

    alice.ws.send(aliceHandshake);
    const bobHandshakeBuf = expectFrame(
      await bob.waitFor(
        (event) =>
          event.kind === 'frame' &&
          event.data.byteLength === aliceHandshake.byteLength &&
          new Uint8Array(event.data)[0] === 0x04,
      ),
    );
    expect(hexEncode(new Uint8Array(bobHandshakeBuf))).toBe(
      hexEncode(new Uint8Array(aliceHandshake)),
    );

    const relayBody = new Uint8Array(64);
    crypto.getRandomValues(relayBody);
    const aliceRelay = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext: relayBody });
    alice.ws.send(aliceRelay);

    const bobRelayBuf = expectFrame(
      await bob.waitFor(
        (event) =>
          event.kind === 'frame' &&
          event.data.byteLength === aliceRelay.byteLength &&
          new Uint8Array(event.data)[0] === 0x05,
      ),
    );
    expect(hexEncode(new Uint8Array(bobRelayBuf))).toBe(hexEncode(new Uint8Array(aliceRelay)));

    alice.close();
    bob.close();
  });

  test('RELAY kind=0x01 chunk frame forwards byte-identical (v2 wire opaque-forward)', async () => {
    const roomId = makeRoomId(6);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');

    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    const bobAck = expectFrame(await bob.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(bobAck)).toEqual({ type: 'ACK', role: 'joiner' });
    await alice.waitFor((event) => event.kind === 'frame' && event.data !== bobAck);

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const chunkCiphertext = new Uint8Array(256);
    crypto.getRandomValues(chunkCiphertext);

    const aliceChunk = encodeRelay({
      kind: RELAY_KIND_CHUNK,
      nonce,
      ciphertext: chunkCiphertext,
    });
    expect(new Uint8Array(aliceChunk)[1]).toBe(RELAY_KIND_CHUNK);

    alice.ws.send(aliceChunk);
    const bobChunkBuf = expectFrame(
      await bob.waitFor(
        (event) =>
          event.kind === 'frame' &&
          event.data.byteLength === aliceChunk.byteLength &&
          new Uint8Array(event.data)[0] === 0x05,
      ),
    );

    expect(hexEncode(new Uint8Array(bobChunkBuf))).toBe(hexEncode(new Uint8Array(aliceChunk)));
    const decoded = decodeServerFrame(bobChunkBuf);
    expect(decoded?.type).toBe('RELAY');
    if (decoded?.type === 'RELAY') {
      expect(decoded.kind).toBe(RELAY_KIND_CHUNK);
      expect(hexEncode(decoded.nonce)).toBe(hexEncode(nonce));
      expect(hexEncode(decoded.ciphertext)).toBe(hexEncode(chunkCiphertext));
    }

    alice.close();
    bob.close();
  });

  test('third client joining a paired room receives ROOM_FULL', async () => {
    const roomId = makeRoomId(2);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');

    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    await bob.waitFor((event) => event.kind === 'frame');

    const charlie = await openClient();
    charlie.ws.send(encodeHello({ roomId, intent: 'join' }));
    const charlieAck = expectFrame(await charlie.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(charlieAck)).toEqual({ type: 'ERROR', code: 'ROOM_FULL' });

    const closed = expectClose(await charlie.waitFor((event) => event.kind === 'close'));
    expect(closed.code).toBe(1008);

    alice.close();
    bob.close();
    charlie.close();
  });

  test('intent=create on an existing room receives ROOM_ALREADY_EXISTS', async () => {
    const roomId = makeRoomId(3);
    const alice = await openClient();
    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');

    const intruder = await openClient();
    intruder.ws.send(encodeHello({ roomId, intent: 'create' }));
    const ack = expectFrame(await intruder.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(ack)).toEqual({ type: 'ERROR', code: 'ROOM_ALREADY_EXISTS' });

    alice.close();
    intruder.close();
  });

  test('intent=join on an unknown room receives ROOM_NOT_FOUND', async () => {
    const roomId = makeRoomId(4);
    const lone = await openClient();
    lone.ws.send(encodeHello({ roomId, intent: 'join' }));
    const ack = expectFrame(await lone.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(ack)).toEqual({ type: 'ERROR', code: 'ROOM_NOT_FOUND' });
    lone.close();
  });

  test('HALF_OPEN grace rejects intent=join from a stranger (slot is reserved for the original peer)', async () => {
    const roomId = makeRoomId(6);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');

    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    await bob.waitFor((event) => event.kind === 'frame');
    await alice.waitFor((event) => event.kind === 'frame');

    bob.close();
    await alice.waitFor((event) => event.kind === 'frame');

    const bob2 = await openClient();
    bob2.ws.send(encodeHello({ roomId, intent: 'join' }));
    const bob2Ack = expectFrame(await bob2.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(bob2Ack)).toEqual({ type: 'ERROR', code: 'ROOM_FULL' });

    await sleep(200);
    expect(alice.events.filter((e) => e.kind === 'frame').length).toBe(3);

    alice.close();
    bob2.close();
  });

  test('HALF_OPEN survivor sending an in-flight RELAY is not closed; room stays resumable', async () => {
    const roomId = makeRoomId(9);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');
    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    await bob.waitFor((event) => event.kind === 'frame');
    await alice.waitFor((event) => event.kind === 'frame');

    bob.close();
    await alice.waitFor((event) => event.kind === 'frame');

    const nonce = new Uint8Array(12);
    nonce[0] = 0x01;
    const relayBody = new Uint8Array(64);
    crypto.getRandomValues(relayBody);
    alice.ws.send(encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext: relayBody }));

    await sleep(150);
    expect(alice.events.some((e) => e.kind === 'close')).toBe(false);

    const bobResume = await openClient();
    bobResume.ws.send(encodeHello({ roomId, intent: 'resume' }));
    const ack = expectFrame(await bobResume.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(ack)).toEqual({ type: 'ACK', role: 'joiner' });

    alice.close();
    bobResume.close();
  });

  test('HALF_OPEN survivor sending a stray in-flight HANDSHAKE is not closed; room stays resumable', async () => {
    const roomId = makeRoomId(11);
    const alice = await openClient();
    const bob = await openClient();

    const isType =
      (type: string) =>
      (event: ServerEvent): boolean =>
        event.kind === 'frame' && decodeServerFrame(event.data)?.type === type;

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor(isType('ACK'));
    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    await bob.waitFor(isType('ACK'));
    await alice.waitFor(isType('PEER_JOINED'));

    const hsNonce = new Uint8Array(12);
    const hsCipher = new Uint8Array(48);
    crypto.getRandomValues(hsCipher);
    alice.ws.send(encodeHandshake(hsNonce, hsCipher));
    await bob.waitFor((event) => event.kind === 'frame' && new Uint8Array(event.data)[0] === 0x04);

    bob.close();
    await alice.waitFor(isType('PEER_DISCONNECTED'));
    await sleep(30);

    const strayCipher = new Uint8Array(48);
    crypto.getRandomValues(strayCipher);
    alice.ws.send(encodeHandshake(hsNonce, strayCipher));

    await sleep(150);
    expect(alice.events.some((e) => e.kind === 'close')).toBe(false);

    const bobResume = await openClient();
    bobResume.ws.send(encodeHello({ roomId, intent: 'resume' }));
    const ack = expectFrame(await bobResume.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(ack)).toEqual({ type: 'ACK', role: 'joiner' });

    alice.close();
    bobResume.close();
  });

  test('HALF_OPEN grace allows intent=resume from the original peer (legitimate F5 / network blip)', async () => {
    const roomId = makeRoomId(7);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    await alice.waitFor((event) => event.kind === 'frame');
    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    await bob.waitFor((event) => event.kind === 'frame');
    await alice.waitFor((event) => event.kind === 'frame');

    bob.close();
    await alice.waitFor((event) => event.kind === 'frame');

    const bobResume = await openClient();
    bobResume.ws.send(encodeHello({ roomId, intent: 'resume' }));
    const ack = expectFrame(await bobResume.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(ack)).toEqual({ type: 'ACK', role: 'joiner' });

    alice.close();
    bobResume.close();
  });

  test('server is mode-agnostic: HELLO carries no mode byte; MODE_MISMATCH is not emitted', async () => {
    const roomId = makeRoomId(5);
    const alice = await openClient();
    const bob = await openClient();

    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    const aliceAck = expectFrame(await alice.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(aliceAck)).toEqual({ type: 'ACK', role: 'initiator' });

    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    const bobAck = expectFrame(await bob.waitFor((event) => event.kind === 'frame'));
    expect(decodeServerFrame(bobAck)).toEqual({ type: 'ACK', role: 'joiner' });

    const alicePeerJoined = expectFrame(
      await alice.waitFor((event) => event.kind === 'frame' && event.data !== aliceAck),
    );
    expect(decodeServerFrame(alicePeerJoined)).toEqual({ type: 'PEER_JOINED' });

    alice.close();
    bob.close();
  });
});

describe('handshake hardening', () => {
  const pair = async (roomId: Bytes): Promise<{ alice: Client; bob: Client }> => {
    const alice = await openClient();
    const bob = await openClient();
    alice.ws.send(encodeHello({ roomId, intent: 'create' }));
    const aliceAck = expectFrame(await alice.waitFor((event) => event.kind === 'frame'));
    bob.ws.send(encodeHello({ roomId, intent: 'join' }));
    await bob.waitFor((event) => event.kind === 'frame');
    await alice.waitFor((event) => event.kind === 'frame' && event.data !== aliceAck);
    return { alice, bob };
  };

  test('HANDSHAKE frame of the wrong length is rejected with INVALID_PAYLOAD', async () => {
    const roomId = makeRoomId(20);
    const { alice, bob } = await pair(roomId);

    const malformed = new Uint8Array(10);
    malformed[0] = 0x04;
    alice.ws.send(malformed);

    const err = expectFrame(
      await alice.waitFor(
        (event) => event.kind === 'frame' && new Uint8Array(event.data)[0] === 0x08,
      ),
    );
    expect(decodeServerFrame(err)).toEqual({ type: 'ERROR', code: 'INVALID_PAYLOAD' });
    await alice.waitFor((event) => event.kind === 'close');

    alice.close();
    bob.close();
  });

  test('a second HANDSHAKE on the same connection is rejected with BAD_STATE', async () => {
    const roomId = makeRoomId(21);
    const { alice, bob } = await pair(roomId);

    const nonce = new Uint8Array(12);
    nonce[0] = 0x01;
    const ciphertext = new Uint8Array(48);
    crypto.getRandomValues(ciphertext);
    const handshake = encodeHandshake(nonce, ciphertext);

    alice.ws.send(handshake);
    await bob.waitFor((event) => event.kind === 'frame' && new Uint8Array(event.data)[0] === 0x04);

    alice.ws.send(handshake);
    const err = expectFrame(
      await alice.waitFor(
        (event) => event.kind === 'frame' && new Uint8Array(event.data)[0] === 0x08,
      ),
    );
    expect(decodeServerFrame(err)).toEqual({ type: 'ERROR', code: 'BAD_STATE' });

    alice.close();
    bob.close();
  });
});

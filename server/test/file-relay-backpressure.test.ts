import { afterEach, describe, expect, test } from 'bun:test';

import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { decodeServerFrame, encodeHello, encodeRelay } from '@unseen/shared/wire/codec.ts';
import { RELAY_KIND_CHUNK } from '@unseen/shared/wire/file-frame.ts';
import { MSG_RELAY } from '@unseen/shared/wire/msg-types.ts';

import type { Config } from '../src/config.ts';
import { DEFAULT_IP_LIMITS } from '../src/ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET } from '../src/ratelimit/relay-bucket.ts';
import { startServer, type StartedServer } from '../src/server.ts';

const TEST_ORIGIN = 'http://localhost';

const baseConfig = (overrides: Partial<Config> = {}): Config => ({
  port: 0,
  host: '127.0.0.1',
  trustedProxyHeader: undefined,
  allowedOrigins: [TEST_ORIGIN],
  ipLimits: DEFAULT_IP_LIMITS,
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

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (s) => await s.stop()));
});

const launch = (config: Config): StartedServer => {
  const started = startServer(config);
  servers.push(started);
  return started;
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type ServerEvent =
  | { kind: 'frame'; data: ArrayBuffer }
  | { kind: 'close'; code: number; reason: string };

type TestClient = {
  readonly ws: WebSocket;
  readonly events: ServerEvent[];
  waitFor: (predicate: (event: ServerEvent) => boolean, timeoutMs?: number) => Promise<ServerEvent>;
  close: () => void;
};

const openClient = async (url: string): Promise<TestClient> => {
  const WsCtor = WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new WsCtor(url, { headers: { Origin: TEST_ORIGIN } });
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
    timeoutMs = 2000,
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
      baseConfig({
        relayBucket: { limit: 5, refillPerSec: 0.001 },
      }),
    );
    const roomId = makeRoomId(1);
    const alice = await openClient(server.url);
    const bob = await openClient(server.url);

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

describe('file relay — slow-receiver peer-buffer cap', () => {
  test.todo('slow receiver hits 8 MiB peer-buffer cap', () => {});
});

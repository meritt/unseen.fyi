import { afterEach, describe, expect, test } from 'bun:test';

import { decodeServerFrame, encodeHandshake, encodeHello } from '@unseen/shared/wire/codec.ts';

import type { Config } from '../src/config.ts';
import { DEFAULT_IP_LIMITS } from '../src/ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET } from '../src/ratelimit/relay-bucket.ts';
import { sweepRooms } from '../src/room/cleanup.ts';
import { createRoomRegistry } from '../src/room/registry.ts';
import { startServer, type StartedServer } from '../src/server.ts';

const HELLO_TIMEOUT_BYTE = 0x0b;

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

const openSocket = async (url: string): Promise<WebSocket> => {
  const WsCtor = WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new WsCtor(url, { headers: { Origin: TEST_ORIGIN } });
  ws.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
  return ws;
};

const waitFor = async <T>(predicate: () => T | undefined, timeoutMs = 1000): Promise<T> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = predicate();
    if (found !== undefined) {
      return found;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error('waitFor timed out');
};

const makeRoomId = (seed: number): Uint8Array<ArrayBuffer> => {
  const id = new Uint8Array(16);
  for (let i = 0; i < id.length; i++) {
    id[i] = (seed * 3 + i) & 0xff;
  }
  return id;
};

describe('per-IP rate limiting', () => {
  test('connect bucket of 2 rejects the third upgrade with RATE_LIMITED', async () => {
    const server = launch(
      baseConfig({
        ipLimits: {
          ...DEFAULT_IP_LIMITS,
          connect: { limit: 2, refillPerSec: 0 },
        },
      }),
    );
    const wsA = await openSocket(server.url);
    const wsB = await openSocket(server.url);
    const wsC = await openSocket(server.url);
    const closedC = await new Promise<{ code: number; reason: string }>((resolve) => {
      wsC.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
    });
    expect(closedC.reason).toBe('RATE_LIMITED');
    wsA.close();
    wsB.close();
  });

  test('newRoom bucket of 1 rejects the second create from the same IP', async () => {
    const server = launch(
      baseConfig({
        ipLimits: {
          ...DEFAULT_IP_LIMITS,
          newRoom: { limit: 1, refillPerSec: 0 },
        },
      }),
    );
    const wsA = await openSocket(server.url);
    wsA.send(encodeHello({ roomId: makeRoomId(1), intent: 'create' }));
    await new Promise<void>((resolve) => {
      wsA.addEventListener('message', () => resolve(), { once: true });
    });

    const wsB = await openSocket(server.url);
    const frames: ArrayBuffer[] = [];
    wsB.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        frames.push(event.data);
      }
    });
    wsB.send(encodeHello({ roomId: makeRoomId(2), intent: 'create' }));
    const frame = await waitFor(() => frames[0]);
    expect(decodeServerFrame(frame)).toEqual({ type: 'ERROR', code: 'RATE_LIMITED' });
    wsA.close();
    wsB.close();
  });
});

describe('HELLO deadline', () => {
  test('connection that never sends HELLO is closed with HELLO_TIMEOUT', async () => {
    const server = launch(baseConfig());
    const ws = await openSocket(server.url);
    const frames: ArrayBuffer[] = [];
    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        frames.push(event.data);
      }
    });

    const frame = await waitFor(() => frames[0], 7000);
    const view = new DataView(frame);
    expect(view.getUint8(0)).toBe(0x08);
    expect(view.getUint8(1)).toBe(HELLO_TIMEOUT_BYTE);
    ws.close();
  }, 10_000);
});

describe('uncaught fetch errors', () => {
  test('uncaught error yields a generic 500 with security headers and no stack', async () => {
    const server = launch(baseConfig({ trustedProxyHeader: '' }));
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toBe('Internal server error');
  });
});

describe('HALF_OPEN handshake metering', () => {
  test('survivor flooding HANDSHAKE in HALF_OPEN is RATE_LIMITED once the relay bucket drains', async () => {
    const server = launch(baseConfig({ relayBucket: { limit: 2, refillPerSec: 0 } }));
    const roomId = makeRoomId(31);
    const alice = await openSocket(server.url);
    const bob = await openSocket(server.url);

    const aliceFrames: ArrayBuffer[] = [];
    let aliceClose: { code: number; reason: string } | undefined;
    alice.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        aliceFrames.push(event.data);
      }
    });
    alice.addEventListener('close', (event) => {
      aliceClose = { code: event.code, reason: event.reason };
    });

    const aliceSees = (type: string): ArrayBuffer | undefined =>
      aliceFrames.find((frame) => decodeServerFrame(frame)?.type === type);

    alice.send(encodeHello({ roomId, intent: 'create' }));
    await waitFor(() => aliceSees('ACK'));
    bob.send(encodeHello({ roomId, intent: 'join' }));
    await waitFor(() => aliceSees('PEER_JOINED'));

    bob.close();
    await waitFor(() => aliceSees('PEER_DISCONNECTED'));

    const nonce = new Uint8Array(12);
    const ciphertext = new Uint8Array(48);
    crypto.getRandomValues(ciphertext);
    for (let i = 0; i < 5; i++) {
      alice.send(encodeHandshake(nonce, ciphertext));
    }

    const closed = await waitFor(() => aliceClose);
    expect(closed.reason).toBe('RATE_LIMITED');
  });
});

describe('cleanup sweep', () => {
  test('HALF_OPEN room past grace is removed and remaining peer gets PEER_LEFT', () => {
    const registry = createRoomRegistry();
    let peerLeftSent = false;
    const stubWs = {
      send: (): number => {
        peerLeftSent = true;
        return 1;
      },
      close: (): void => undefined,
    };
    const room = registry.create('abc', stubWs as never);
    room.state = 'HALF_OPEN';
    room.lastActivityAtMs = 0;
    const outcome = sweepRooms(registry, 999_999_999);
    expect(outcome.graceExpired).toBe(1);
    expect(registry.size()).toBe(0);
    expect(peerLeftSent).toBe(true);
  });
});

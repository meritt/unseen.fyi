import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { decodeServerFrame } from '@unseen/shared/wire/codec.ts';

import { type Config, loadConfig } from '../src/config.ts';
import { createMetricsCounters } from '../src/metrics/counters.ts';
import { createIpLimiter } from '../src/ratelimit/ip-limiter.ts';
import { createRoomRegistry } from '../src/room/registry.ts';
import { WS_CLOSE_POLICY_VIOLATION } from '../src/room/send.ts';
import { startServer, type StartedServer } from '../src/server.ts';
import { createHandlers } from '../src/wire/handlers.ts';
import {
  createWs,
  opened,
  RELAXED_IP_LIMITS,
  stubWs,
  testConfig,
  withEnv,
} from './_helpers/harness.ts';

const MAX_CONNECTIONS = 2;
const SETTLE_MS = 50;

let started: StartedServer;

beforeAll(() => {
  started = startServer(
    testConfig({ ipLimits: RELAXED_IP_LIMITS, maxConnections: MAX_CONNECTIONS }),
  );
});

afterAll(async () => {
  await started.stop();
});

type Peer = {
  readonly ws: WebSocket;
  readonly frames: ArrayBuffer[];
  readonly closed: Promise<number>;
};

const connect = async (): Promise<Peer> => {
  const ws = createWs(started.url);
  const frames: ArrayBuffer[] = [];
  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      frames.push(event.data);
    }
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code), { once: true });
  });
  await opened(ws);
  return { ws, frames, closed };
};

const closedWithin = async (peer: Peer, ms: number): Promise<boolean> =>
  (await Promise.race([peer.closed, Bun.sleep(ms)])) !== undefined;

const closeAll = async (peers: readonly Peer[]): Promise<void> => {
  for (const peer of peers) {
    peer.ws.close();
  }
  await Promise.all(peers.map(async (peer) => await peer.closed));
};

describe('relay connection ceiling', () => {
  test('a connection past the ceiling gets OVER_CAPACITY and is closed', async () => {
    const held = await Promise.all([connect(), connect()]);
    try {
      const extra = await connect();
      expect(await extra.closed).toBe(WS_CLOSE_POLICY_VIOLATION);
      expect(extra.frames.map((frame) => decodeServerFrame(frame))).toEqual([
        { type: 'ERROR', code: 'OVER_CAPACITY' },
      ]);
      expect(started.counters.snapshot().capacityRejections).toBe(1);
      expect(await closedWithin(held[0], SETTLE_MS)).toBe(false);
      expect(await closedWithin(held[1], SETTLE_MS)).toBe(false);
    } finally {
      await closeAll(held);
    }
  });

  test('a slot freed by a close is admitted again', async () => {
    const held = await Promise.all([connect(), connect()]);
    await closeAll([held[0]]);
    await Bun.sleep(SETTLE_MS);

    const revived = await connect();
    try {
      expect(await closedWithin(revived, SETTLE_MS)).toBe(false);
    } finally {
      await closeAll([held[1], revived]);
    }
  });
});

const ceilingHandlers = (config: Config) => {
  const counters = createMetricsCounters();
  const handlers = createHandlers({
    registry: createRoomRegistry(),
    ipLimiter: createIpLimiter(config.ipLimits),
    config,
    counters,
  });
  return { handlers, counters };
};

describe('ceiling accounting', () => {
  test('a rate-limited flood does not consume the ceiling', () => {
    const config = testConfig({
      maxConnections: 2,
      ipLimits: { ...RELAXED_IP_LIMITS, connect: { limit: 1, refillPerSec: 0 } },
    });
    const { handlers, counters } = ceilingHandlers(config);

    const held = stubWs('203.0.113.1', config);
    handlers.open(held.ws);
    expect(held.closes).toEqual([]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = stubWs('203.0.113.1', config);
      handlers.open(rejected.ws);
      expect(rejected.closes).toEqual([WS_CLOSE_POLICY_VIOLATION]);
    }

    const legit = stubWs('198.51.100.7', config);
    handlers.open(legit.ws);
    try {
      expect(legit.closes).toEqual([]);
      expect(counters.snapshot().capacityRejections).toBe(0);
    } finally {
      handlers.close(held.ws);
      handlers.close(legit.ws);
    }
  });

  test('the ceiling refuses one past the admitted limit and frees the slot on close', () => {
    const config = testConfig({ maxConnections: 2, ipLimits: RELAXED_IP_LIMITS });
    const { handlers, counters } = ceilingHandlers(config);

    const first = stubWs('203.0.113.2', config);
    const second = stubWs('203.0.113.3', config);
    handlers.open(first.ws);
    handlers.open(second.ws);

    const refused = stubWs('203.0.113.4', config);
    handlers.open(refused.ws);
    expect(refused.closes).toEqual([WS_CLOSE_POLICY_VIOLATION]);
    expect(counters.snapshot().capacityRejections).toBe(1);

    handlers.close(first.ws);
    const admitted = stubWs('203.0.113.5', config);
    handlers.open(admitted.ws);
    try {
      expect(admitted.closes).toEqual([]);
    } finally {
      handlers.close(second.ws);
      handlers.close(admitted.ws);
    }
  });
});

describe('connection ceiling configuration', () => {
  test('loadConfig defaults UNSEEN_MAX_CONNECTIONS to 256', async () => {
    await withEnv({ UNSEEN_MAX_CONNECTIONS: undefined }, () => {
      expect(loadConfig().maxConnections).toBe(256);
    });
  });

  test('loadConfig honours a UNSEEN_MAX_CONNECTIONS override', async () => {
    await withEnv({ UNSEEN_MAX_CONNECTIONS: '3' }, () => {
      expect(loadConfig().maxConnections).toBe(3);
    });
  });

  test.each(['0', '-1', '1.5', 'many'])(
    'loadConfig rejects UNSEEN_MAX_CONNECTIONS=%s',
    async (raw) => {
      await withEnv({ UNSEEN_MAX_CONNECTIONS: raw }, () => {
        expect(() => loadConfig()).toThrow(/UNSEEN_MAX_CONNECTIONS/u);
      });
    },
  );
});

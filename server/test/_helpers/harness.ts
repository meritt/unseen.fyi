import type { ServerWebSocket } from 'bun';

import type { Config } from '../../src/config.ts';
import { DEFAULT_IP_LIMITS, type IpLimiterConfig } from '../../src/ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET } from '../../src/ratelimit/relay-bucket.ts';
import type { ConnectionData } from '../../src/types.ts';
import { createInitialConnectionData } from '../../src/wire/handlers.ts';

export const TEST_ORIGIN = 'http://localhost';

export const RELAXED_IP_LIMITS = {
  connect: { limit: 1000, refillPerSec: 1000 },
  newRoom: { limit: 1000, refillPerSec: 1000 },
  joinRoom: { limit: 1000, refillPerSec: 1000 },
  health: { limit: 1000, refillPerSec: 1000 },
} satisfies IpLimiterConfig;

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
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
  maxConnections: 1000,
  ...overrides,
});

const WebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

export const createWs = (url: string): WebSocket => {
  const ws = new WebSocketWithHeaders(url, { headers: { Origin: TEST_ORIGIN } });
  ws.binaryType = 'arraybuffer';
  return ws;
};

export const opened = async (ws: WebSocket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
};

export const openWs = async (url: string): Promise<WebSocket> => {
  const ws = createWs(url);
  await opened(ws);
  return ws;
};

const setEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(Bun.env, key);
  } else {
    Bun.env[key] = value;
  }
};

export const withEnv = async <T>(
  env: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const original = Object.keys(env).map((key) => [key, Bun.env[key]] as const);
  for (const [key, value] of Object.entries(env)) {
    setEnv(key, value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of original) {
      setEnv(key, value);
    }
  }
};

export const emitMemoryPressure = (level: 'warning' | 'critical'): void => {
  process.emit('memoryPressure' as never, level as never);
};

export type StubSocket = {
  readonly ws: ServerWebSocket<ConnectionData>;
  readonly closes: number[];
};

export type ServerEvent =
  | { kind: 'frame'; data: ArrayBuffer }
  | { kind: 'close'; code: number; reason: string };

export type Peer = {
  readonly ws: WebSocket;
  readonly events: ServerEvent[];
  waitFor: (predicate: (event: ServerEvent) => boolean, timeoutMs?: number) => Promise<ServerEvent>;
  close: () => void;
};

export const waitFor = async <T>(predicate: () => T | undefined, timeoutMs = 1000): Promise<T> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = predicate();
    if (found !== undefined) {
      return found;
    }
    await Bun.sleep(20);
  }
  throw new Error('waitFor timed out');
};

export const openPeer = async (url: string): Promise<Peer> => {
  const ws = createWs(url);
  const events: ServerEvent[] = [];
  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      events.push({ kind: 'frame', data: event.data });
    }
  });
  ws.addEventListener('close', (event) => {
    events.push({ kind: 'close', code: event.code, reason: event.reason });
  });
  await opened(ws);
  return {
    ws,
    events,
    waitFor: async (predicate, timeoutMs = 2000): Promise<ServerEvent> =>
      await waitFor(() => events.find((event) => predicate(event)), timeoutMs),
    close: (): void => ws.close(),
  };
};

export const stubWs = (ip = '127.0.0.1', config: Config = testConfig()): StubSocket => {
  const closes: number[] = [];
  const ws = {
    data: createInitialConnectionData(ip, config),
    send: (): number => 1,
    close: (code: number): void => {
      closes.push(code);
    },
    getBufferedAmount: (): number => 0,
  } as unknown as ServerWebSocket<ConnectionData>;
  return { ws, closes };
};

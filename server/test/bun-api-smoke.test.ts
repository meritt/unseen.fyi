import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MAX_WIRE_BYTES } from '@unseen/shared/limits.ts';

import type { Config } from '../src/config.ts';
import { DEFAULT_IP_LIMITS } from '../src/ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET } from '../src/ratelimit/relay-bucket.ts';
import { startServer, type StartedServer } from '../src/server.ts';

const TEST_ORIGIN = 'http://localhost';

const testConfig = (overrides: Partial<Config> = {}): Config => ({
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

let started: StartedServer;

beforeAll(() => {
  started = startServer(testConfig());
});

afterAll(async () => {
  await started.stop();
});

describe('Bun.file Content-Type defaults', () => {
  test('infers MIME type from extension', async () => {
    const tmp = `/tmp/unseen-smoke-${String(Date.now())}`;
    await Bun.write(`${tmp}.html`, '<!doctype html>');
    await Bun.write(`${tmp}.js`, 'export {};');
    await Bun.write(`${tmp}.css`, 'body{}');
    await Bun.write(`${tmp}.svg`, '<svg/>');
    expect(Bun.file(`${tmp}.html`).type).toMatch(/^text\/html/u);
    expect(Bun.file(`${tmp}.js`).type).toMatch(/^text\/javascript/u);
    expect(Bun.file(`${tmp}.css`).type).toMatch(/^text\/css/u);
    expect(Bun.file(`${tmp}.svg`).type).toMatch(/^image\/svg\+xml/u);
  });

  test('Bun.file(path).exists() returns Promise<boolean>', async () => {
    expect(await Bun.file('/this/path/does/not/exist').exists()).toBe(false);
  });
});

describe('Bun.env mirrors process.env', () => {
  test('returns the same value via Bun.env and process.env', () => {
    process.env.UNSEEN_SMOKE_PROBE = 'sentinel';
    expect(Bun.env.UNSEEN_SMOKE_PROBE).toBe('sentinel');
    delete process.env.UNSEEN_SMOKE_PROBE;
  });
});

describe('performance.now monotonicity', () => {
  test('reads forward in time across two consecutive samples', async () => {
    const a = performance.now();
    await Bun.sleep(2);
    const b = performance.now();
    expect(b).toBeGreaterThan(a);
  });
});

describe('Bun.serve maxPayloadLength enforcement', () => {
  test('the server tears down WS frames exceeding MAX_WIRE_BYTES', async () => {
    const WsCtor = WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new WsCtor(started.url, { headers: { Origin: TEST_ORIGIN } });
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('open failed')), { once: true });
    });
    const oversized = new Uint8Array(MAX_WIRE_BYTES + 1);
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener(
        'close',
        (event) => {
          resolve({ code: event.code });
        },
        { once: true },
      );
    });
    ws.send(oversized);
    const result = await closed;
    expect([1006, 1009]).toContain(result.code);
  });
});

describe('ws.send return value semantics', () => {
  test('client-side send accepts ArrayBuffer and returns void/undefined (browser API contract)', async () => {
    const WsCtor = WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new WsCtor(started.url, { headers: { Origin: TEST_ORIGIN } });
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('open failed')), { once: true });
    });
    const result = ws.send(new Uint8Array(8));
    expect(result).toBeUndefined();
    ws.close();
  });
});

describe('server.stop is awaitable and graceful', () => {
  test('starting and stopping a fresh server does not throw', async () => {
    const fresh = startServer(testConfig());
    await fresh.stop();
  });
});

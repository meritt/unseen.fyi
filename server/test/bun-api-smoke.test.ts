import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MAX_WIRE_BYTES } from '@unseen/shared/limits.ts';

import { startServer, type StartedServer } from '../src/server.ts';
import { emitMemoryPressure, openWs, testConfig } from './_helpers/harness.ts';

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
    const ws = await openWs(started.url);
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
    const ws = await openWs(started.url);
    const result = ws.send(new Uint8Array(8));
    expect(result).toBeUndefined();
    ws.close();
  });
});

describe('memory pressure does not disturb live sessions', () => {
  test('an open WebSocket survives a memoryPressure event', async () => {
    const ws = await openWs(started.url);
    try {
      emitMemoryPressure('critical');
      await Bun.sleep(50);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});

describe('server.stop is awaitable and graceful', () => {
  test('starting and stopping a fresh server does not throw', async () => {
    const fresh = startServer(testConfig());
    await fresh.stop();
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Config } from '../src/config.ts';
import { DEFAULT_IP_LIMITS } from '../src/ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET } from '../src/ratelimit/relay-bucket.ts';
import { startServer, type StartedServer } from '../src/server.ts';
import { SECURITY_HEADERS } from '../src/static/headers.ts';

const INDEX_HTML =
  '<!doctype html><html><head><title>Unseen</title></head><body><main>landing</main></body></html>';
const R402_HTML =
  '<!doctype html><html><head><title>Unseen</title></head><body><main>chat-shell</main></body></html>';
const MAIN_JS = 'console.log("unseen-main");\n';
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

let fixtureDir: string;
let server: StartedServer;

const baseConfig = (overrides: Partial<Config> = {}): Config => ({
  port: 0,
  host: '127.0.0.1',
  trustedProxyHeader: undefined,
  allowedOrigins: ['http://localhost'],
  ipLimits: DEFAULT_IP_LIMITS,
  relayBucket: DEFAULT_RELAY_BUCKET,
  clientDistDir: fixtureDir,
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

const baseUrl = (): string => `http://${server.url.replace(/^ws:\/\//u, '').replace(/\/ws$/u, '')}`;

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'unseen-static-'));
  mkdirSync(path.join(fixtureDir, 'assets'));
  writeFileSync(path.join(fixtureDir, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(fixtureDir, 'r402.html'), R402_HTML);
  writeFileSync(path.join(fixtureDir, 'assets', 'main.js'), MAIN_JS);
  writeFileSync(path.join(fixtureDir, 'favicon.svg'), FAVICON_SVG);
  server = startServer(baseConfig());
});

afterAll(async () => {
  await server.stop();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('healthz endpoint', () => {
  test('returns 200 "ok"', async () => {
    const res = await fetch(`${baseUrl()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('per-IP rate-limit returns 429 after burst', async () => {
    const localServer = startServer(
      baseConfig({
        ipLimits: { ...DEFAULT_IP_LIMITS, health: { limit: 2, refillPerSec: 0 } },
      }),
    );
    try {
      const base = `http://${localServer.url.replace(/^ws:\/\//u, '').replace(/\/ws$/u, '')}`;
      const first = await fetch(`${base}/healthz`);
      const second = await fetch(`${base}/healthz`);
      const third = await fetch(`${base}/healthz`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
    } finally {
      await localServer.stop();
    }
  });
});

describe('SPA paths', () => {
  test('/ returns index.html with no-cache, ETag, and CSP', async () => {
    const res = await fetch(`${baseUrl()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{64}"$/u);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  test('/r402 returns r402.html (distinct from index.html)', async () => {
    const res = await fetch(`${baseUrl()}/r402`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(R402_HTML);
  });

  test('/ ETag differs from /r402 ETag (content-derived)', async () => {
    const [a, b] = await Promise.all([fetch(`${baseUrl()}/`), fetch(`${baseUrl()}/r402`)]);
    const aTag = a.headers.get('etag');
    const bTag = b.headers.get('etag');
    expect(aTag).not.toBeNull();
    expect(bTag).not.toBeNull();
    expect(aTag).not.toBe(bTag);
  });

  test('If-None-Match matching ETag returns 304 with no body', async () => {
    const first = await fetch(`${baseUrl()}/`);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    await first.text();
    const second = await fetch(`${baseUrl()}/`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('etag')).toBe(etag);
  });

  test('If-None-Match mismatch still returns 200 body', async () => {
    const res = await fetch(`${baseUrl()}/`, { headers: { 'if-none-match': 'W/"deadbeef"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });
});

describe('static assets', () => {
  test('allowlisted asset served with immutable cache', async () => {
    const res = await fetch(`${baseUrl()}/assets/main.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MAIN_JS);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  test('favicon.svg served', async () => {
    const res = await fetch(`${baseUrl()}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FAVICON_SVG);
  });

  test('allowlist miss returns 404', async () => {
    const res = await fetch(`${baseUrl()}/foo.bar`);
    expect(res.status).toBe(404);
  });

  test('path traversal /../etc/passwd is normalized and rejected', async () => {
    const res = await fetch(`${baseUrl()}/../etc/passwd`);
    expect(res.status).toBe(404);
  });

  test('percent-encoded traversal /assets/%2e%2e%2fpasswd is rejected', async () => {
    const res = await fetch(`${baseUrl()}/assets/%2e%2e%2fpasswd`);
    expect(res.status).toBe(404);
  });

  test('asset with wrong extension is rejected', async () => {
    const res = await fetch(`${baseUrl()}/assets/main.exe`);
    expect(res.status).toBe(404);
  });

  test('missing-but-allowed asset returns 404', async () => {
    const res = await fetch(`${baseUrl()}/assets/missing.js`);
    expect(res.status).toBe(404);
  });
});

describe('content-encoding negotiation', () => {
  test('Accept-Encoding: br serves brotli, decoding back to the original asset', async () => {
    const res = await fetch(`${baseUrl()}/assets/main.js`, {
      headers: { 'accept-encoding': 'br' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('vary')).toBe('accept-encoding');
    expect(await res.text()).toBe(MAIN_JS);
  });

  test('Accept-Encoding: gzip still serves gzip', async () => {
    const res = await fetch(`${baseUrl()}/assets/main.js`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(await res.text()).toBe(MAIN_JS);
  });

  test('when both are offered brotli wins', async () => {
    const res = await fetch(`${baseUrl()}/assets/main.js`, {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(res.headers.get('content-encoding')).toBe('br');
  });

  test('Accept-Encoding: identity serves the asset uncompressed', async () => {
    const res = await fetch(`${baseUrl()}/assets/main.js`, {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(MAIN_JS);
  });
});

describe('security headers on every response (not just files)', () => {
  const expectSecurityHeaders = (res: Response): void => {
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(SECURITY_HEADERS[name]!);
    }
  };

  test('404 carries the security headers', async () => {
    const res = await fetch(`${baseUrl()}/foo.bar`);
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('/healthz carries the security headers', async () => {
    const res = await fetch(`${baseUrl()}/healthz`);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  test('disallowed method returns 405 with Allow + security headers', async () => {
    const res = await fetch(`${baseUrl()}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expectSecurityHeaders(res);
  });

  test('forbidden WS origin returns 403 with security headers', async () => {
    const res = await fetch(`${baseUrl()}/ws`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  test('WS upgrade without upgrade headers returns 426 with security headers', async () => {
    const res = await fetch(`${baseUrl()}/ws`, { headers: { origin: 'http://localhost' } });
    expect(res.status).toBe(426);
    expectSecurityHeaders(res);
  });
});

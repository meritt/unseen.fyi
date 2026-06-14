import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config.ts';
import { createMetricsCounters } from '../src/metrics/counters.ts';
import { startMetricsServer } from '../src/metrics/server.ts';
import { DEFAULT_IP_LIMITS } from '../src/ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET } from '../src/ratelimit/relay-bucket.ts';
import { createRoomRegistry } from '../src/room/registry.ts';

const withEnv = async <T>(
  env: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const target = Bun.env as Record<string, string | undefined>;
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = target[key];
    const v = env[key];
    target[key] = v ?? '';
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      target[key] = value ?? '';
    }
  }
};

const baseConfig = () => ({
  port: 0,
  host: '127.0.0.1',
  trustedProxyHeader: undefined,
  allowedOrigins: undefined,
  ipLimits: DEFAULT_IP_LIMITS,
  relayBucket: DEFAULT_RELAY_BUCKET,
  clientDistDir: '/tmp',
  metricsEnabled: false,
  metricsUser: undefined as string | undefined,
  metricsPass: undefined as string | undefined,
  metricsBind: '127.0.0.1',
  metricsPort: 0,
  gracePeriodMs: 300_000,
  sweepIntervalMs: 30_000,
  keepaliveIntervalMs: 20_000,
});

describe('loadConfig metrics gating', () => {
  test('UNSEEN_METRICS_ENABLED=true without USER/PASS throws', async () => {
    await withEnv(
      {
        UNSEEN_METRICS_ENABLED: 'true',
        UNSEEN_METRICS_USER: undefined,
        UNSEEN_METRICS_PASS: undefined,
      },
      () => {
        expect(() => loadConfig()).toThrow(/UNSEEN_METRICS_ENABLED/u);
      },
    );
  });

  test('UNSEEN_METRICS_ENABLED=true with creds parses successfully', async () => {
    await withEnv(
      {
        UNSEEN_METRICS_ENABLED: 'true',
        UNSEEN_METRICS_USER: 'observer',
        UNSEEN_METRICS_PASS: 'opensesame',
        UNSEEN_METRICS_PORT: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.metricsEnabled).toBe(true);
        expect(config.metricsUser).toBe('observer');
        expect(config.metricsPass).toBe('opensesame');
      },
    );
  });

  test('default config has metrics disabled', async () => {
    await withEnv(
      {
        UNSEEN_METRICS_ENABLED: undefined,
        UNSEEN_METRICS_USER: undefined,
        UNSEEN_METRICS_PASS: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.metricsEnabled).toBe(false);
        expect(config.metricsBind).toBe('127.0.0.1');
      },
    );
  });
});

describe('startMetricsServer', () => {
  test('returns null when metrics disabled', () => {
    const counters = createMetricsCounters();
    const registry = createRoomRegistry();
    const server = startMetricsServer(baseConfig(), counters, registry);
    expect(server).toBeNull();
  });

  test('serves Prometheus text with valid Basic auth', async () => {
    const counters = createMetricsCounters();
    counters.incConnection();
    counters.incRelay();
    const registry = createRoomRegistry();
    const config = {
      ...baseConfig(),
      metricsEnabled: true,
      metricsUser: 'observer',
      metricsPass: 'opensesame',
    };
    const server = startMetricsServer(config, counters, registry);
    if (server === null) {
      throw new Error('expected metrics server to start');
    }
    try {
      const auth = `Basic ${btoa('observer:opensesame')}`;
      const url = `http://${server.hostname}:${String(server.port)}/metrics`;
      const res = await fetch(url, { headers: { authorization: auth } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await res.text();
      expect(body).toContain('unseen_active_rooms');
      expect(body).toContain('unseen_connections_total 1');
      expect(body).toContain('unseen_relays_total 1');
    } finally {
      server.stop(true);
    }
  });

  test('rejects requests without credentials', async () => {
    const counters = createMetricsCounters();
    const registry = createRoomRegistry();
    const config = {
      ...baseConfig(),
      metricsEnabled: true,
      metricsUser: 'observer',
      metricsPass: 'opensesame',
    };
    const server = startMetricsServer(config, counters, registry);
    if (server === null) {
      throw new Error('expected metrics server to start');
    }
    try {
      const url = `http://${server.hostname}:${String(server.port)}/metrics`;
      const res = await fetch(url);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      server.stop(true);
    }
  });

  test('rejects wrong credentials', async () => {
    const counters = createMetricsCounters();
    const registry = createRoomRegistry();
    const config = {
      ...baseConfig(),
      metricsEnabled: true,
      metricsUser: 'observer',
      metricsPass: 'opensesame',
    };
    const server = startMetricsServer(config, counters, registry);
    if (server === null) {
      throw new Error('expected metrics server to start');
    }
    try {
      const url = `http://${server.hostname}:${String(server.port)}/metrics`;
      const res = await fetch(url, {
        headers: { authorization: `Basic ${btoa('observer:WRONG')}` },
      });
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test('binds to 127.0.0.1 by default (not externally reachable)', () => {
    const counters = createMetricsCounters();
    const registry = createRoomRegistry();
    const config = {
      ...baseConfig(),
      metricsEnabled: true,
      metricsUser: 'observer',
      metricsPass: 'opensesame',
    };
    const server = startMetricsServer(config, counters, registry);
    try {
      expect(server?.hostname).toBe('127.0.0.1');
    } finally {
      server?.stop(true);
    }
  });

  test('non-/metrics paths return 404 on the metrics port', async () => {
    const counters = createMetricsCounters();
    const registry = createRoomRegistry();
    const config = {
      ...baseConfig(),
      metricsEnabled: true,
      metricsUser: 'observer',
      metricsPass: 'opensesame',
    };
    const server = startMetricsServer(config, counters, registry);
    if (server === null) {
      throw new Error('expected metrics server to start');
    }
    try {
      const auth = `Basic ${btoa('observer:opensesame')}`;
      const url = `http://${server.hostname}:${String(server.port)}/healthz`;
      const res = await fetch(url, { headers: { authorization: auth } });
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

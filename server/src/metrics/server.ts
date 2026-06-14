import type { Config } from '../config.ts';
import type { RoomRegistry } from '../room/registry.ts';
import type { MetricsCounters } from './counters.ts';

type Server = ReturnType<typeof Bun.serve>;

const HARDENING_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

const authorize = (request: Request, expected: Uint8Array<ArrayBuffer>): boolean => {
  const header = request.headers.get('authorization');
  if (header === null || header === '') {
    return false;
  }
  const presented = new TextEncoder().encode(header);
  if (presented.byteLength !== expected.byteLength) {
    return false;
  }
  return crypto.timingSafeEqual(presented, expected);
};

const renderPrometheus = (counters: MetricsCounters, registry: RoomRegistry): string => {
  const counts = registry.counts();
  const snapshot = counters.snapshot();
  return [
    '# HELP unseen_active_rooms Currently active (paired) rooms.',
    '# TYPE unseen_active_rooms gauge',
    `unseen_active_rooms ${String(counts.active)}`,
    '',
    '# HELP unseen_waiting_rooms Rooms waiting for a peer to join.',
    '# TYPE unseen_waiting_rooms gauge',
    `unseen_waiting_rooms ${String(counts.waiting)}`,
    '',
    '# HELP unseen_half_open_rooms Rooms in the post-disconnect grace window.',
    '# TYPE unseen_half_open_rooms gauge',
    `unseen_half_open_rooms ${String(counts.halfOpen)}`,
    '',
    '# HELP unseen_connections_total Total WebSocket upgrades since start.',
    '# TYPE unseen_connections_total counter',
    `unseen_connections_total ${String(snapshot.totalConnections)}`,
    '',
    '# HELP unseen_relays_total RELAY frames forwarded since start.',
    '# TYPE unseen_relays_total counter',
    `unseen_relays_total ${String(snapshot.relaysTotal)}`,
    '',
    '# HELP unseen_rate_limit_rejections_total Requests rejected by the per-IP rate limiter.',
    '# TYPE unseen_rate_limit_rejections_total counter',
    `unseen_rate_limit_rejections_total ${String(snapshot.rateLimitRejections)}`,
    '',
  ].join('\n');
};

export const startMetricsServer = (
  config: Config,
  counters: MetricsCounters,
  registry: RoomRegistry,
): Server | null => {
  if (!config.metricsEnabled) {
    return null;
  }
  const user = config.metricsUser;
  const pass = config.metricsPass;
  if (user === undefined || pass === undefined) {
    throw new Error('metrics enabled but credentials missing — loadConfig should have rejected');
  }
  const expectedAuth = `Basic ${btoa(`${user}:${pass}`)}`;
  const expectedBytes = new TextEncoder().encode(expectedAuth);

  return Bun.serve({
    hostname: config.metricsBind,
    port: config.metricsPort,
    development: false,
    error() {
      return new Response('Internal server error', { status: 500, headers: HARDENING_HEADERS });
    },
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/metrics') {
        return new Response('Not found', { status: 404, headers: HARDENING_HEADERS });
      }
      if (!authorize(request, expectedBytes)) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="metrics"', ...HARDENING_HEADERS },
        });
      }
      return new Response(renderPrometheus(counters, registry), {
        headers: { 'content-type': 'text/plain; version=0.0.4', ...HARDENING_HEADERS },
      });
    },
  });
};

import type { Config } from '../config.ts';
import type { RoomRegistry } from '../room/registry.ts';
import type { MetricsCounters } from './counters.ts';

type Server = ReturnType<typeof Bun.serve>;

const HARDENING_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

const memoryFootprint = (): number => Bun.unsafe.memoryFootprint() ?? process.memoryUsage.rss();

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

const metric = (name: string, type: 'gauge' | 'counter', help: string, value: number): string =>
  `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${String(value)}\n`;

const renderPrometheus = (counters: MetricsCounters, registry: RoomRegistry): string => {
  const counts = registry.counts();
  const snapshot = counters.snapshot();
  return [
    metric(
      'unseen_memory_bytes',
      'gauge',
      'Memory footprint of the relay process in bytes.',
      memoryFootprint(),
    ),
    metric('unseen_active_rooms', 'gauge', 'Currently active (paired) rooms.', counts.active),
    metric('unseen_waiting_rooms', 'gauge', 'Rooms waiting for a peer to join.', counts.waiting),
    metric(
      'unseen_half_open_rooms',
      'gauge',
      'Rooms in the post-disconnect grace window.',
      counts.halfOpen,
    ),
    metric(
      'unseen_connections_total',
      'counter',
      'Total WebSocket upgrades since start.',
      snapshot.totalConnections,
    ),
    metric(
      'unseen_relays_total',
      'counter',
      'RELAY frames forwarded since start.',
      snapshot.relaysTotal,
    ),
    metric(
      'unseen_rate_limit_rejections_total',
      'counter',
      'Requests rejected by the per-IP rate limiter.',
      snapshot.rateLimitRejections,
    ),
    metric(
      'unseen_capacity_rejections_total',
      'counter',
      'Connections refused at the relay connection ceiling.',
      snapshot.capacityRejections,
    ),
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

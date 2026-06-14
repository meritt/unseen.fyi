import { MAX_WIRE_BYTES } from '@unseen/shared/limits.ts';

import type { Config } from './config.ts';
import { logger, startAggregateEmitter } from './log/log.ts';
import { createMetricsCounters, type MetricsCounters } from './metrics/counters.ts';
import { startMetricsServer } from './metrics/server.ts';
import { createIpLimiter } from './ratelimit/ip-limiter.ts';
import { startCleanupSweeper } from './room/cleanup.ts';
import { startKeepalive } from './room/keepalive.ts';
import { createRoomRegistry } from './room/registry.ts';
import { withSecurityHeaders } from './static/headers.ts';
import { handleHttpRequest } from './static/serve.ts';
import { createHandlers, createInitialConnectionData } from './wire/handlers.ts';
import { extractIp } from './wire/ip.ts';
import { isAllowedOrigin } from './wire/origin.ts';

const AGGREGATE_EMIT_INTERVAL_MS = 60_000;

const internalErrorResponse = (): Response => {
  logger.error('uncaught_fetch_error');
  return withSecurityHeaders(new Response('Internal server error', { status: 500 }));
};

const methodNotAllowed = (): Response =>
  withSecurityHeaders(
    new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } }),
  );

export type StartedServer = {
  readonly url: string;
  readonly port: number;
  readonly metricsPort: number | undefined;
  readonly counters: MetricsCounters;
  readonly stop: () => Promise<void>;
};

export const startServer = (config: Config): StartedServer => {
  const registry = createRoomRegistry();
  const ipLimiter = createIpLimiter(config.ipLimits);
  const counters = createMetricsCounters();
  const handlers = createHandlers({ registry, ipLimiter, config, counters });
  const cleanup = startCleanupSweeper(
    registry,
    config.gracePeriodMs,
    config.sweepIntervalMs,
    ipLimiter,
  );
  const keepalive = startKeepalive(registry, config.keepaliveIntervalMs);
  const metricsServer = startMetricsServer(config, counters, registry);
  const aggregate = startAggregateEmitter(() => {
    const counts = registry.counts();
    return {
      ...counts,
      activeRooms: counts.active,
      waitingRooms: counts.waiting,
      totalConnections: counters.snapshot().totalConnections,
    };
  }, AGGREGATE_EMIT_INTERVAL_MS);

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    development: false,
    error: internalErrorResponse,
    async fetch(request, srv) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowed();
      }
      const url = new URL(request.url);
      if (url.pathname === '/ws') {
        if (!isAllowedOrigin({ request, url, allowedOrigins: config.allowedOrigins })) {
          return withSecurityHeaders(new Response('Forbidden origin', { status: 403 }));
        }
        const ip = extractIp(request, srv, config.trustedProxyHeader);
        const upgraded = srv.upgrade(request, {
          data: createInitialConnectionData(ip, config),
        });
        if (upgraded) {
          counters.incConnection();
        }
        return upgraded
          ? undefined
          : withSecurityHeaders(new Response('Upgrade failed', { status: 426 }));
      }
      return withSecurityHeaders(
        await handleHttpRequest({ request, url, server: srv, config, ipLimiter }),
      );
    },

    websocket: {
      maxPayloadLength: MAX_WIRE_BYTES,
      idleTimeout: 0,
      perMessageDeflate: false,
      sendPings: false,
      open: handlers.open,
      message: handlers.message,
      close: handlers.close,
    },
  });

  const boundPort = server.port ?? config.port;
  return {
    url: `ws://${server.hostname}:${boundPort}/ws`,
    port: boundPort,
    metricsPort: metricsServer?.port ?? undefined,
    counters,
    stop: async (): Promise<void> => {
      cleanup.stop();
      keepalive.stop();
      aggregate.stop();
      void server.stop(true);
      if (metricsServer !== null) {
        void metricsServer.stop(true);
      }
      await Promise.resolve();
    },
  };
};

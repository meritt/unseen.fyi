import path from 'node:path';

import { GRACE_PERIOD_MS, SWEEP_INTERVAL_MS } from '@unseen/shared/limits.ts';

import {
  type ActionLimits,
  DEFAULT_IP_LIMITS,
  type IpLimiterConfig,
} from './ratelimit/ip-limiter.ts';
import { DEFAULT_RELAY_BUCKET, type RelayBucketConfig } from './ratelimit/relay-bucket.ts';

export type Config = {
  readonly port: number;
  readonly host: string;
  readonly trustedProxyHeader: string | undefined;
  readonly allowedOrigins: readonly string[] | undefined;
  readonly ipLimits: IpLimiterConfig;
  readonly relayBucket: RelayBucketConfig;
  readonly clientDistDir: string;
  readonly metricsEnabled: boolean;
  readonly metricsUser: string | undefined;
  readonly metricsPass: string | undefined;
  readonly metricsBind: string;
  readonly metricsPort: number;
  readonly gracePeriodMs: number;
  readonly sweepIntervalMs: number;
  readonly keepaliveIntervalMs: number;
};

const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_METRICS_BIND = '127.0.0.1';
const DEFAULT_METRICS_PORT = 9101;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
const DEFAULT_CLIENT_DIST_DIR = path.resolve(import.meta.dir, '../../client/dist');

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`UNSEEN_PORT must be an integer in [1, 65535], got: ${raw}`);
  }
  return value;
};

const parseAllowedOrigins = (raw: string | undefined): readonly string[] | undefined => {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const list = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  return list.length === 0 ? undefined : list;
};

const overrideLimits = (action: keyof IpLimiterConfig, base: ActionLimits): ActionLimits => {
  const limit = Bun.env[`UNSEEN_RL_${action.toUpperCase()}_LIMIT`];
  const refill = Bun.env[`UNSEEN_RL_${action.toUpperCase()}_REFILL_PER_SEC`];
  return {
    limit: limit === undefined ? base.limit : Number(limit),
    refillPerSec: refill === undefined ? base.refillPerSec : Number(refill),
  };
};

const parseMetricsPort = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') {
    return DEFAULT_METRICS_PORT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`UNSEEN_METRICS_PORT must be an integer in [1, 65535], got: ${raw}`);
  }
  return value;
};

const parseGracePeriodMs = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') {
    return GRACE_PERIOD_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`UNSEEN_GRACE_MS must be a non-negative number, got: ${raw}`);
  }
  return value;
};

const parseSweepIntervalMs = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') {
    return SWEEP_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`UNSEEN_SWEEP_MS must be a positive number, got: ${raw}`);
  }
  return value;
};

const parseKeepaliveIntervalMs = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') {
    return DEFAULT_KEEPALIVE_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`UNSEEN_WS_KEEPALIVE_MS must be a positive number, got: ${raw}`);
  }
  return value;
};

const trimOrUndefined = (raw: string | undefined): string | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
};

export const loadConfig = (): Config => {
  const metricsEnabled = Bun.env.UNSEEN_METRICS_ENABLED === 'true';
  const metricsUser = trimOrUndefined(Bun.env.UNSEEN_METRICS_USER);
  const metricsPass = trimOrUndefined(Bun.env.UNSEEN_METRICS_PASS);
  if (metricsEnabled && (metricsUser === undefined || metricsPass === undefined)) {
    throw new Error(
      'UNSEEN_METRICS_ENABLED=true requires UNSEEN_METRICS_USER and UNSEEN_METRICS_PASS',
    );
  }
  return {
    port: parsePort(Bun.env.UNSEEN_PORT),
    host: Bun.env.UNSEEN_HOST ?? DEFAULT_HOST,
    // empty header must collapse to undefined: headers.get('') throws per request
    trustedProxyHeader: trimOrUndefined(Bun.env.UNSEEN_PROXY_HEADER),
    allowedOrigins: parseAllowedOrigins(Bun.env.UNSEEN_ALLOWED_ORIGINS),
    ipLimits: {
      connect: overrideLimits('connect', DEFAULT_IP_LIMITS.connect),
      newRoom: overrideLimits('newRoom', DEFAULT_IP_LIMITS.newRoom),
      joinRoom: overrideLimits('joinRoom', DEFAULT_IP_LIMITS.joinRoom),
      health: overrideLimits('health', DEFAULT_IP_LIMITS.health),
    },
    relayBucket: {
      limit:
        Bun.env.UNSEEN_RL_RELAY_LIMIT === undefined
          ? DEFAULT_RELAY_BUCKET.limit
          : Number(Bun.env.UNSEEN_RL_RELAY_LIMIT),
      refillPerSec:
        Bun.env.UNSEEN_RL_RELAY_REFILL_PER_SEC === undefined
          ? DEFAULT_RELAY_BUCKET.refillPerSec
          : Number(Bun.env.UNSEEN_RL_RELAY_REFILL_PER_SEC),
    },
    clientDistDir:
      Bun.env.UNSEEN_CLIENT_DIST_DIR === undefined || Bun.env.UNSEEN_CLIENT_DIST_DIR === ''
        ? DEFAULT_CLIENT_DIST_DIR
        : path.resolve(Bun.env.UNSEEN_CLIENT_DIST_DIR),
    metricsEnabled,
    metricsUser,
    metricsPass,
    metricsBind: trimOrUndefined(Bun.env.UNSEEN_METRICS_BIND) ?? DEFAULT_METRICS_BIND,
    metricsPort: parseMetricsPort(Bun.env.UNSEEN_METRICS_PORT),
    gracePeriodMs: parseGracePeriodMs(Bun.env.UNSEEN_GRACE_MS),
    sweepIntervalMs: parseSweepIntervalMs(Bun.env.UNSEEN_SWEEP_MS),
    keepaliveIntervalMs: parseKeepaliveIntervalMs(Bun.env.UNSEEN_WS_KEEPALIVE_MS),
  };
};

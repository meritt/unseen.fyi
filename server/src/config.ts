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

type NumberRule = {
  readonly valid: (value: number) => boolean;
  readonly expected: string;
};

const PORT: NumberRule = {
  valid: (value) => Number.isInteger(value) && value >= 1 && value <= 65_535,
  expected: 'an integer in [1, 65535]',
};

const POSITIVE_INTEGER: NumberRule = {
  valid: (value) => Number.isInteger(value) && value >= 1,
  expected: 'a positive integer',
};

// a timer delay past this is clamped to 1ms, turning an interval into a busy loop
const MAX_TIMER_MS = 2_147_483_647;

const INTERVAL: NumberRule = {
  valid: (value) => Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS,
  expected: `a positive number of milliseconds not above ${String(MAX_TIMER_MS)}`,
};

const NON_NEGATIVE: NumberRule = {
  valid: (value) => Number.isFinite(value) && value >= 0,
  expected: 'a non-negative number',
};

const envNumber = (name: string, fallback: number, rule: NumberRule): number => {
  const raw = Bun.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!rule.valid(value)) {
    throw new Error(`${name} must be ${rule.expected}, got: ${raw}`);
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
  const prefix = `UNSEEN_RL_${action.toUpperCase()}`;
  return {
    limit: envNumber(`${prefix}_LIMIT`, base.limit, NON_NEGATIVE),
    refillPerSec: envNumber(`${prefix}_REFILL_PER_SEC`, base.refillPerSec, NON_NEGATIVE),
  };
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
    port: envNumber('UNSEEN_PORT', DEFAULT_PORT, PORT),
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
      limit: envNumber('UNSEEN_RL_RELAY_LIMIT', DEFAULT_RELAY_BUCKET.limit, NON_NEGATIVE),
      refillPerSec: envNumber(
        'UNSEEN_RL_RELAY_REFILL_PER_SEC',
        DEFAULT_RELAY_BUCKET.refillPerSec,
        NON_NEGATIVE,
      ),
    },
    clientDistDir:
      Bun.env.UNSEEN_CLIENT_DIST_DIR === undefined || Bun.env.UNSEEN_CLIENT_DIST_DIR === ''
        ? DEFAULT_CLIENT_DIST_DIR
        : path.resolve(Bun.env.UNSEEN_CLIENT_DIST_DIR),
    metricsEnabled,
    metricsUser,
    metricsPass,
    metricsBind: trimOrUndefined(Bun.env.UNSEEN_METRICS_BIND) ?? DEFAULT_METRICS_BIND,
    metricsPort: envNumber('UNSEEN_METRICS_PORT', DEFAULT_METRICS_PORT, PORT),
    gracePeriodMs: envNumber('UNSEEN_GRACE_MS', GRACE_PERIOD_MS, NON_NEGATIVE),
    sweepIntervalMs: envNumber('UNSEEN_SWEEP_MS', SWEEP_INTERVAL_MS, INTERVAL),
    keepaliveIntervalMs: envNumber(
      'UNSEEN_WS_KEEPALIVE_MS',
      DEFAULT_KEEPALIVE_INTERVAL_MS,
      INTERVAL,
    ),
  };
};

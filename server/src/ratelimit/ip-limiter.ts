import { isIP } from 'node:net';

export type IpAction = 'connect' | 'newRoom' | 'joinRoom' | 'health';

export type ActionLimits = {
  readonly limit: number;
  readonly refillPerSec: number;
};

export type IpLimiterConfig = Readonly<Record<IpAction, ActionLimits>>;

export const DEFAULT_IP_LIMITS: IpLimiterConfig = {
  connect: { limit: 100, refillPerSec: 100 / 60 },
  newRoom: { limit: 10, refillPerSec: 10 / 60 },
  joinRoom: { limit: 30, refillPerSec: 30 / 60 },
  health: { limit: 60, refillPerSec: 60 / 60 },
};

const IDLE_BUCKET_TTL_MS = 10 * 60 * 1000;

export const MAX_BUCKETS_PER_MAP = 50_000;

const groupSpan = (groups: readonly string[]): number =>
  groups.reduce((total, group) => total + (group.includes('.') ? 2 : 1), 0);

const ipv6Prefix64 = (ip: string): string => {
  const [head = '', tail] = ip.toLowerCase().split('::', 2);
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array.from({ length: 8 - groupSpan(headGroups) - groupSpan(tailGroups) }, () => '0'),
          ...tailGroups,
        ];
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/u, ''))
    .join(':');
  return `${prefix}::/64`;
};

const bucketKey = (ip: string): string => (isIP(ip) === 6 ? ipv6Prefix64(ip) : ip);

type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

export type IpLimiter = {
  check: (ip: string, action: IpAction) => boolean;
  gc: (now?: number) => void;
  size: (action: IpAction) => number;
};

export const createIpLimiter = (limits: IpLimiterConfig = DEFAULT_IP_LIMITS): IpLimiter => {
  const buckets: Record<IpAction, Map<string, Bucket>> = {
    connect: new Map(),
    newRoom: new Map(),
    joinRoom: new Map(),
    health: new Map(),
  };

  const check = (ip: string, action: IpAction): boolean => {
    const actionLimits = limits[action];
    const map = buckets[action];
    const key = bucketKey(ip);
    const now = performance.now();
    const bucket = map.get(key);
    if (bucket === undefined && map.size >= MAX_BUCKETS_PER_MAP) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
    const tokens = (() => {
      if (bucket === undefined) {
        return actionLimits.limit;
      }
      const elapsedSec = (now - bucket.lastRefillMs) / 1000;
      return Math.min(actionLimits.limit, bucket.tokens + elapsedSec * actionLimits.refillPerSec);
    })();
    if (tokens < 1) {
      map.set(key, { tokens, lastRefillMs: now });
      return false;
    }
    map.set(key, { tokens: tokens - 1, lastRefillMs: now });
    return true;
  };

  const gc = (now: number = performance.now()): void => {
    const cutoff = now - IDLE_BUCKET_TTL_MS;
    for (const map of Object.values(buckets)) {
      for (const [ip, bucket] of map) {
        if (bucket.lastRefillMs < cutoff) {
          map.delete(ip);
        }
      }
    }
  };

  return {
    check,
    gc,
    size: (action): number => buckets[action].size,
  };
};

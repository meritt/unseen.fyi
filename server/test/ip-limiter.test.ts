import { describe, expect, test } from 'bun:test';

import { createIpLimiter, MAX_BUCKETS_PER_MAP } from '../src/ratelimit/ip-limiter.ts';

const strictLimits = {
  connect: { limit: 1, refillPerSec: 0 },
  newRoom: { limit: 1, refillPerSec: 0 },
  joinRoom: { limit: 1, refillPerSec: 0 },
  health: { limit: 1, refillPerSec: 0 },
} as const;

describe('IP-based token bucket', () => {
  test('blocks once the burst is exhausted from the same IP', () => {
    const limiter = createIpLimiter({
      connect: { limit: 3, refillPerSec: 0 },
      newRoom: { limit: 3, refillPerSec: 0 },
      joinRoom: { limit: 3, refillPerSec: 0 },
      health: { limit: 3, refillPerSec: 0 },
    });
    expect(limiter.check('1.1.1.1', 'connect')).toBe(true);
    expect(limiter.check('1.1.1.1', 'connect')).toBe(true);
    expect(limiter.check('1.1.1.1', 'connect')).toBe(true);
    expect(limiter.check('1.1.1.1', 'connect')).toBe(false);
  });

  test('different IPs get independent buckets', () => {
    const limiter = createIpLimiter({
      connect: { limit: 1, refillPerSec: 0 },
      newRoom: { limit: 1, refillPerSec: 0 },
      joinRoom: { limit: 1, refillPerSec: 0 },
      health: { limit: 1, refillPerSec: 0 },
    });
    expect(limiter.check('1.1.1.1', 'connect')).toBe(true);
    expect(limiter.check('2.2.2.2', 'connect')).toBe(true);
    expect(limiter.check('1.1.1.1', 'connect')).toBe(false);
  });

  test('actions track separately for the same IP', () => {
    const limiter = createIpLimiter({
      connect: { limit: 1, refillPerSec: 0 },
      newRoom: { limit: 1, refillPerSec: 0 },
      joinRoom: { limit: 1, refillPerSec: 0 },
      health: { limit: 1, refillPerSec: 0 },
    });
    expect(limiter.check('1.1.1.1', 'connect')).toBe(true);
    expect(limiter.check('1.1.1.1', 'newRoom')).toBe(true);
    expect(limiter.check('1.1.1.1', 'joinRoom')).toBe(true);
    expect(limiter.check('1.1.1.1', 'newRoom')).toBe(false);
  });

  test('gc evicts buckets idle past the 10-minute TTL', () => {
    const limiter = createIpLimiter({
      connect: { limit: 1, refillPerSec: 0 },
      newRoom: { limit: 1, refillPerSec: 0 },
      joinRoom: { limit: 1, refillPerSec: 0 },
      health: { limit: 1, refillPerSec: 0 },
    });
    limiter.check('9.9.9.9', 'connect');
    expect(limiter.size('connect')).toBe(1);
    limiter.gc(performance.now() + 11 * 60 * 1000);
    expect(limiter.size('connect')).toBe(0);
  });

  test('gc keeps buckets that are still within the TTL', () => {
    const limiter = createIpLimiter({
      connect: { limit: 1, refillPerSec: 0 },
      newRoom: { limit: 1, refillPerSec: 0 },
      joinRoom: { limit: 1, refillPerSec: 0 },
      health: { limit: 1, refillPerSec: 0 },
    });
    limiter.check('9.9.9.9', 'connect');
    limiter.gc(performance.now());
    expect(limiter.size('connect')).toBe(1);
  });
});

describe('IPv6 /64 folding', () => {
  test('two addresses in the same /64 share one bucket', () => {
    const limiter = createIpLimiter(strictLimits);
    expect(limiter.check('2001:db8:1:2::1', 'connect')).toBe(true);
    expect(limiter.check('2001:db8:1:2:ffff:ffff:ffff:ffff', 'connect')).toBe(false);
    expect(limiter.size('connect')).toBe(1);
  });

  test('addresses in different /64s get independent buckets', () => {
    const limiter = createIpLimiter(strictLimits);
    expect(limiter.check('2001:db8:1:2::1', 'connect')).toBe(true);
    expect(limiter.check('2001:db8:1:3::1', 'connect')).toBe(true);
    expect(limiter.size('connect')).toBe(2);
  });

  test('compressed and expanded forms of one address share a bucket', () => {
    const limiter = createIpLimiter(strictLimits);
    expect(limiter.check('2001:0db8:0000:0000:0000:0000:0000:0001', 'connect')).toBe(true);
    expect(limiter.check('2001:db8::2', 'connect')).toBe(false);
    expect(limiter.size('connect')).toBe(1);
  });

  test('IPv4 addresses are keyed individually', () => {
    const limiter = createIpLimiter(strictLimits);
    expect(limiter.check('10.0.0.1', 'connect')).toBe(true);
    expect(limiter.check('10.0.0.2', 'connect')).toBe(true);
    expect(limiter.size('connect')).toBe(2);
  });
});

describe('per-map entry cap', () => {
  test('insert at the cap evicts the oldest bucket instead of blocking new clients', () => {
    const limiter = createIpLimiter(strictLimits);
    for (let i = 0; i < MAX_BUCKETS_PER_MAP; i++) {
      limiter.check(`key-${String(i)}`, 'connect');
    }
    expect(limiter.size('connect')).toBe(MAX_BUCKETS_PER_MAP);

    expect(limiter.check('key-0', 'connect')).toBe(false);
    expect(limiter.check('fresh', 'connect')).toBe(true);
    expect(limiter.size('connect')).toBe(MAX_BUCKETS_PER_MAP);

    expect(limiter.check('key-0', 'connect')).toBe(true);
    expect(limiter.size('connect')).toBe(MAX_BUCKETS_PER_MAP);
  });
});

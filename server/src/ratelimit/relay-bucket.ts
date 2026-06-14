export type RelayBucketConfig = {
  readonly limit: number;
  readonly refillPerSec: number;
};

export const DEFAULT_RELAY_BUCKET: RelayBucketConfig = {
  limit: 2000,
  refillPerSec: 200,
};

export type RelayBucket = {
  tokens: number;
  lastRefillMs: number;
};

export const createRelayBucket = (
  config: RelayBucketConfig = DEFAULT_RELAY_BUCKET,
): RelayBucket => ({
  tokens: config.limit,
  lastRefillMs: performance.now(),
});

export const consumeRelayToken = (
  bucket: RelayBucket,
  config: RelayBucketConfig = DEFAULT_RELAY_BUCKET,
): boolean => {
  const now = performance.now();
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  const refilled = Math.min(config.limit, bucket.tokens + elapsedSec * config.refillPerSec);
  bucket.lastRefillMs = now;
  if (refilled < 1) {
    bucket.tokens = refilled;
    return false;
  }
  bucket.tokens = refilled - 1;
  return true;
};

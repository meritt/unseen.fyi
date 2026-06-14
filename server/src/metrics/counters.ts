export type RateLimitBucket = 'connect' | 'newRoom' | 'joinRoom' | 'health';

export type MetricsSnapshot = {
  readonly totalConnections: number;
  readonly relaysTotal: number;
  readonly rateLimitRejections: number;
};

export type MetricsCounters = {
  readonly incConnection: () => void;
  readonly incRelay: () => void;
  readonly incRateLimitReject: (bucket: RateLimitBucket) => void;
  readonly snapshot: () => MetricsSnapshot;
};

export const createMetricsCounters = (): MetricsCounters => {
  let totalConnections = 0;
  let relaysTotal = 0;
  let rateLimitRejections = 0;
  return {
    incConnection: (): void => {
      totalConnections += 1;
    },
    incRelay: (): void => {
      relaysTotal += 1;
    },
    incRateLimitReject: (): void => {
      rateLimitRejections += 1;
    },
    snapshot: (): MetricsSnapshot => ({ totalConnections, relaysTotal, rateLimitRejections }),
  };
};

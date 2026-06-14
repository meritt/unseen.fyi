import type { Role } from '@unseen/shared/wire/role.ts';

import type { RelayBucket } from './ratelimit/relay-bucket.ts';

export type ConnectionData = {
  state: ConnectionState;
  roomId: string | undefined;
  role: Role | undefined;
  ip: string;
  helloTimer: ReturnType<typeof setTimeout> | undefined;
  relayBucket: RelayBucket;
  handshakeForwards: number;
};

export type ConnectionState = 'PENDING_HELLO' | 'WAITING_FOR_PEER' | 'PAIRED';

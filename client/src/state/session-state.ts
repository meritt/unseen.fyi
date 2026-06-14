import type { SessionMode } from '@unseen/shared/wire/mode.ts';
import type { Role } from '@unseen/shared/wire/role.ts';

import { Signal } from './signal.ts';

export type SessionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'RESUMING'
  | 'RESUME_LOCKED'
  | 'WAITING_FOR_PEER'
  | 'HANDSHAKING'
  | 'ACTIVE'
  | 'UPGRADING_LOCAL'
  | 'REKEYING'
  | 'PEER_RECONNECTING'
  | 'RECONNECTING'
  | 'FATAL_ENDING'
  | 'TERMINATED';

export const sessionState = new Signal<SessionState>('IDLE');

export const sessionMode = new Signal<SessionMode>('RAM');

export const peerMode = new Signal<SessionMode>('RAM');

export const myRole = new Signal<Role | undefined>(undefined);
export const reconnectAttemptAtMs = new Signal<number | undefined>(undefined);

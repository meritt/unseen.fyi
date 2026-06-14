import { BUFFER_THRESHOLD_BYTES } from '@unseen/shared/limits.ts';

export type Preflight = 'ok' | 'not_ready' | 'backpressure';

export const canAttemptSend = (ws: WebSocket): Preflight => {
  if (ws.readyState !== WebSocket.OPEN) {
    return 'not_ready';
  }
  if (ws.bufferedAmount > BUFFER_THRESHOLD_BYTES) {
    return 'backpressure';
  }
  return 'ok';
};

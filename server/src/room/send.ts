import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { encodeError } from '@unseen/shared/wire/codec.ts';
import type { ErrorCode } from '@unseen/shared/wire/error-codes.ts';
import type { ServerWebSocket } from 'bun';

import type { ConnectionData } from '../types.ts';

export type SendStatus = 'sent' | 'queued' | 'dropped';

const WS_CLOSE_POLICY_VIOLATION = 1008;
const WS_CLOSE_MESSAGE_TOO_LARGE = 1009;
const WS_CLOSE_INTERNAL = 1011;

const classify = (returned: number): SendStatus => {
  if (returned === 0) {
    return 'dropped';
  }
  if (returned < 0) {
    return 'queued';
  }
  return 'sent';
};

export const safeSend = (
  ws: ServerWebSocket<ConnectionData>,
  data: ArrayBuffer | Bytes,
): SendStatus => classify(ws.send(data));

const closeCodeForError = (code: ErrorCode): number => {
  if (code === 'MESSAGE_TOO_LARGE') {
    return WS_CLOSE_MESSAGE_TOO_LARGE;
  }
  if (code === 'INTERNAL') {
    return WS_CLOSE_INTERNAL;
  }
  return WS_CLOSE_POLICY_VIOLATION;
};

export const sendErrorAndClose = (ws: ServerWebSocket<ConnectionData>, code: ErrorCode): void => {
  safeSend(ws, encodeError(code));
  ws.close(closeCodeForError(code), code);
};

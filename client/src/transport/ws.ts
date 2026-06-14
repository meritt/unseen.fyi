import { decodeServerFrame, type ServerFrame } from '@unseen/shared/wire/codec.ts';

export type CloseKind = 'clean' | 'abnormal' | 'error';

export type ConnectionHandlers = {
  readonly onFrame: (frame: ServerFrame) => void;
  readonly onClose: (kind: CloseKind, code: number, reason: string) => void;
  readonly onProtocolError: (kind: ProtocolError) => void;
};

export type ProtocolError =
  | 'invalid_wire_type_text'
  | 'invalid_wire_type_not_arraybuffer'
  | 'invalid_frame';

export type Connection = {
  readonly socket: WebSocket;
  readonly send: (data: ArrayBuffer) => void;
  readonly close: (code?: number, reason?: string) => void;
};

const MISSING_CODE = 0;

const handleIncoming = (event: MessageEvent, handlers: ConnectionHandlers): void => {
  if (typeof event.data === 'string') {
    handlers.onProtocolError('invalid_wire_type_text');
    return;
  }
  if (!(event.data instanceof ArrayBuffer)) {
    handlers.onProtocolError('invalid_wire_type_not_arraybuffer');
    return;
  }
  const frame = decodeServerFrame(event.data);
  if (frame === undefined) {
    handlers.onProtocolError('invalid_frame');
    return;
  }
  handlers.onFrame(frame);
};

export const openConnection = (url: string, handlers: ConnectionHandlers): Connection => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  // a failed socket fires error then close; collapse to one onClose so reconnect fires once
  let closed = false;
  const closeOnce = (kind: CloseKind, code: number, reason: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    handlers.onClose(kind, code, reason);
  };

  ws.addEventListener('message', (event) => {
    handleIncoming(event, handlers);
  });
  ws.addEventListener('close', (event) => {
    closeOnce(event.wasClean ? 'clean' : 'abnormal', event.code, event.reason);
  });
  ws.addEventListener('error', () => {
    closeOnce('error', MISSING_CODE, '');
  });

  return {
    socket: ws,
    send: (data): void => {
      ws.send(data);
    },
    close: (code, reason): void => {
      ws.close(code, reason);
    },
  };
};

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'level',
  'time',
  'msg',
  'port',
  'errorClass',
  'errorCode',
  'activeRooms',
  'waitingRooms',
  'totalConnections',
  'rateLimitBucket',
]);

const ENUM_VALUE_KEYS: ReadonlySet<string> = new Set([
  'errorClass',
  'errorCode',
  'rateLimitBucket',
]);

const ENUM_VALUE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MSG_RE = /^[A-Za-z0-9 .,:_-]{1,200}$/u;

type LogLevel = 'info' | 'warn' | 'error';

type LogFields = Readonly<Record<string, unknown>>;

const sanitize = (level: LogLevel, msg: string, fields: LogFields): string => {
  const safeMsg = MSG_RE.test(msg) ? msg : 'log_msg_rejected';
  const out: Record<string, unknown> = { level, time: Date.now(), msg: safeMsg };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (ENUM_VALUE_KEYS.has(key) && (typeof value !== 'string' || !ENUM_VALUE_RE.test(value))) {
      continue;
    }
    out[key] = value;
  }
  return `${JSON.stringify(out)}\n`;
};

const write = (level: LogLevel, msg: string, fields: LogFields): void => {
  const line = sanitize(level, msg, fields);
  const stream = level === 'info' ? process.stdout : process.stderr;
  stream.write(line);
};

export const logger = {
  info: (msg: string, fields: LogFields = {}): void => {
    write('info', msg, fields);
  },
  warn: (msg: string, fields: LogFields = {}): void => {
    write('warn', msg, fields);
  },
  error: (msg: string, fields: LogFields = {}): void => {
    write('error', msg, fields);
  },
};

export const sanitizeLine = sanitize;

export type AggregateSnapshot = {
  readonly activeRooms: number;
  readonly waitingRooms: number;
  readonly totalConnections: number;
};

export type AggregateEmitter = {
  readonly stop: () => void;
};

export const startAggregateEmitter = (
  snapshot: () => AggregateSnapshot,
  intervalMs: number,
): AggregateEmitter => {
  const timer = setInterval(() => {
    const sample = snapshot();
    logger.info('aggregate_metrics', {
      activeRooms: sample.activeRooms,
      waitingRooms: sample.waitingRooms,
      totalConnections: sample.totalConnections,
    });
  }, intervalMs);
  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
};

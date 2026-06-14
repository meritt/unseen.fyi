import type { Role } from '@unseen/shared/wire/role.ts';

export type StoredSession = {
  readonly r: 'i' | 'j';
  readonly k: string;
  readonly s: string;
  readonly n: string;
  readonly cid: string;
  readonly sas?: string;
  readonly mode_phase?: 'soft' | 'hardened';
  readonly rekey_in_progress?: boolean;
};

const ROLE_TO_SHORT: Readonly<Record<Role, 'i' | 'j'>> = { initiator: 'i', joiner: 'j' };
const SHORT_TO_ROLE: Readonly<Record<'i' | 'j', Role>> = { i: 'initiator', j: 'joiner' };

export const encodeRole = (role: Role): 'i' | 'j' => ROLE_TO_SHORT[role];
export const decodeRole = (shorthand: 'i' | 'j'): Role => SHORT_TO_ROLE[shorthand];

type RawStoredSession = {
  r?: unknown;
  k?: unknown;
  s?: unknown;
  n?: unknown;
  cid?: unknown;
  sas?: unknown;
  mode_phase?: unknown;
  rekey_in_progress?: unknown;
};

const COUNTER_RE = /^\d+$/u;

const isCounterString = (value: unknown): value is string =>
  typeof value === 'string' && COUNTER_RE.test(value);

const hasRequiredFields = (
  record: RawStoredSession,
): record is RawStoredSession & {
  r: 'i' | 'j';
  k: string;
  s: string;
  n: string;
  cid: string;
} =>
  (record.r === 'i' || record.r === 'j') &&
  typeof record.k === 'string' &&
  isCounterString(record.s) &&
  isCounterString(record.n) &&
  typeof record.cid === 'string';

const parseStored = (raw: string): StoredSession | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as RawStoredSession;
  if (!hasRequiredFields(record)) {
    return undefined;
  }
  const sas = typeof record.sas === 'string' ? record.sas : undefined;
  const modePhase =
    record.mode_phase === 'soft' || record.mode_phase === 'hardened'
      ? record.mode_phase
      : undefined;
  const rekeyInProgress = record.rekey_in_progress === true ? true : undefined;
  return {
    r: record.r,
    k: record.k,
    s: record.s,
    n: record.n,
    cid: record.cid,
    ...(sas === undefined ? {} : { sas }),
    ...(modePhase === undefined ? {} : { mode_phase: modePhase }),
    ...(rekeyInProgress === undefined ? {} : { rekey_in_progress: rekeyInProgress }),
  };
};

export const readStoredSession = (storageKey: string): StoredSession | undefined => {
  const raw = globalThis.sessionStorage.getItem(storageKey);
  if (raw === null) {
    return undefined;
  }
  return parseStored(raw);
};

export const writeStoredSession = (storageKey: string, state: StoredSession): void => {
  globalThis.sessionStorage.setItem(storageKey, JSON.stringify(state));
};

export const clearStoredSession = (storageKey: string): void => {
  globalThis.sessionStorage.removeItem(storageKey);
};

export type StoredSessionMirror = {
  readonly storageKey: string;
  readonly initial: StoredSession;
  setCounterSend: (counter: bigint) => void;
  setCounterRecv: (counter: bigint) => void;
};

export const mirrorStoredSession = (
  storageKey: string,
  initial: StoredSession,
): StoredSessionMirror => {
  let current: StoredSession = initial;
  const flush = (): void => {
    writeStoredSession(storageKey, current);
  };
  return {
    storageKey,
    initial,
    setCounterSend: (counter: bigint): void => {
      current = { ...current, s: counter.toString() };
      flush();
    },
    setCounterRecv: (counter: bigint): void => {
      current = { ...current, n: counter.toString() };
      flush();
    },
  };
};

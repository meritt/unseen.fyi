import type { Bytes } from '../crypto/encoding.ts';
import { MAX_BODY_BYTES, MAX_PLAINTEXT_BYTES } from '../limits.ts';

const MAX_NAME_BYTES_WIRE = 1024;
const ID_HEX_RE = /^[0-9a-f]{16}$/u;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;
const TID_ALL_ZERO = '0000000000000000';
const DECLINE_REASONS = ['too_large', 'user_rejected', 'unsupported'] as const;
const CANCEL_REASONS = ['user_aborted', 'integrity_failure', 'session_rekey'] as const;
const CANCEL_SIDES = ['sender', 'receiver'] as const;

export type FileDeclineReason = (typeof DECLINE_REASONS)[number];
export type FileCancelReason = (typeof CANCEL_REASONS)[number];
export type FileCancelSide = (typeof CANCEL_SIDES)[number];

export type PlaintextEnvelope =
  | { readonly kind: 'msg'; readonly body: string; readonly t: string }
  | { readonly kind: 'resume'; readonly _id: string }
  | { readonly kind: 'resume_ack'; readonly _id: string }
  | {
      readonly kind: 'file_offer';
      readonly tid: string;
      readonly name: string;
      readonly size: number;
    }
  | { readonly kind: 'file_accept'; readonly tid: string }
  | { readonly kind: 'file_decline'; readonly tid: string; readonly reason: FileDeclineReason }
  | { readonly kind: 'file_progress'; readonly tid: string; readonly received_bytes: number }
  | { readonly kind: 'file_complete'; readonly tid: string; readonly sender_sha256: string }
  | { readonly kind: 'file_complete_ack'; readonly tid: string }
  | {
      readonly kind: 'file_cancel';
      readonly tid: string;
      readonly side: FileCancelSide;
      readonly reason: FileCancelReason;
    };

type EnvelopeKind = PlaintextEnvelope['kind'];

const SHAPE_ERROR = 'envelope shape invalid';

function fail(): never {
  throw new Error(SHAPE_ERROR);
}

const encoder = new TextEncoder();

const utf8ByteLength = (s: string): number => encoder.encode(s).byteLength;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => {
  if (typeof value !== 'string') {
    fail();
  }
  return value;
};

const asBody = (value: unknown): string => {
  const s = asString(value);
  if (utf8ByteLength(s) > MAX_BODY_BYTES) {
    fail();
  }
  return s;
};

const asId = (value: unknown): string => {
  const s = asString(value);
  if (!ID_HEX_RE.test(s)) {
    fail();
  }
  return s;
};

const asTid = (value: unknown): string => {
  const s = asId(value);
  if (s === TID_ALL_ZERO) {
    fail();
  }
  return s;
};

const asName = (value: unknown): string => {
  const s = asString(value);
  if (utf8ByteLength(s) > MAX_NAME_BYTES_WIRE) {
    fail();
  }
  return s;
};

const asInteger = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail();
  }
  return value;
};

const asSize = (value: unknown): number => {
  const n = asInteger(value);
  if (n < 1) {
    fail();
  }
  return n;
};

const asReceivedBytes = (value: unknown): number => {
  const n = asInteger(value);
  if (n < 0) {
    fail();
  }
  return n;
};

const asSenderSha256 = (value: unknown): string => {
  const s = asString(value);
  if (!SHA256_HEX_RE.test(s)) {
    fail();
  }
  return s;
};

const asEnum = <T extends string>(value: unknown, members: readonly T[]): T => {
  const s = asString(value);
  const match = members.find((m) => m === s);
  if (match === undefined) {
    fail();
  }
  return match;
};

const asDeclineReason = (value: unknown): FileDeclineReason => asEnum(value, DECLINE_REASONS);
const asCancelReason = (value: unknown): FileCancelReason => asEnum(value, CANCEL_REASONS);
const asCancelSide = (value: unknown): FileCancelSide => asEnum(value, CANCEL_SIDES);

type Parser<K extends EnvelopeKind> = (
  record: Record<string, unknown>,
) => Extract<PlaintextEnvelope, { kind: K }>;

const PARSERS: { readonly [K in EnvelopeKind]: Parser<K> } = {
  msg: (r) => ({ kind: 'msg', body: asBody(r.body), t: asString(r.t) }),
  resume: (r) => ({ kind: 'resume', _id: asId(r._id) }),
  resume_ack: (r) => ({ kind: 'resume_ack', _id: asId(r._id) }),
  file_offer: (r) => ({
    kind: 'file_offer',
    tid: asTid(r.tid),
    name: asName(r.name),
    size: asSize(r.size),
  }),
  file_accept: (r) => ({ kind: 'file_accept', tid: asTid(r.tid) }),
  file_decline: (r) => ({
    kind: 'file_decline',
    tid: asTid(r.tid),
    reason: asDeclineReason(r.reason),
  }),
  file_progress: (r) => ({
    kind: 'file_progress',
    tid: asTid(r.tid),
    received_bytes: asReceivedBytes(r.received_bytes),
  }),
  file_complete: (r) => ({
    kind: 'file_complete',
    tid: asTid(r.tid),
    sender_sha256: asSenderSha256(r.sender_sha256),
  }),
  file_complete_ack: (r) => ({ kind: 'file_complete_ack', tid: asTid(r.tid) }),
  file_cancel: (r) => ({
    kind: 'file_cancel',
    tid: asTid(r.tid),
    side: asCancelSide(r.side),
    reason: asCancelReason(r.reason),
  }),
};

const REQUIRED_FIELD_COUNT: { readonly [K in EnvelopeKind]: number } = {
  msg: 2,
  resume: 1,
  resume_ack: 1,
  file_offer: 3,
  file_accept: 1,
  file_decline: 2,
  file_progress: 2,
  file_complete: 2,
  file_complete_ack: 1,
  file_cancel: 3,
};

const KNOWN_KINDS = new Set<string>(Object.keys(PARSERS));

const isKnownKind = (value: unknown): value is EnvelopeKind =>
  typeof value === 'string' && KNOWN_KINDS.has(value);

const decoder = new TextDecoder('utf-8', { fatal: true });

export const encodeEnvelope = (envelope: PlaintextEnvelope): Bytes => {
  if (envelope.kind === 'msg' && utf8ByteLength(envelope.body) > MAX_BODY_BYTES) {
    throw new Error('body exceeds MAX_BODY_BYTES');
  }
  const encoded = encoder.encode(JSON.stringify(envelope));
  if (encoded.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error('plaintext exceeds MAX_PLAINTEXT_BYTES');
  }
  return encoded;
};

export const decodeEnvelope = (bytes: Bytes): PlaintextEnvelope => {
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error('plaintext exceeds MAX_PLAINTEXT_BYTES');
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail();
  }
  if (!isPlainObject(parsed) || !isKnownKind(parsed.kind)) {
    fail();
  }
  const { kind } = parsed;
  if (Object.keys(parsed).length !== REQUIRED_FIELD_COUNT[kind] + 1) {
    fail();
  }
  return PARSERS[kind](parsed);
};

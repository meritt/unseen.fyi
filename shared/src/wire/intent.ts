export type HelloIntent = 'create' | 'join' | 'resume';

export const INTENT_CREATE = 0x01;
export const INTENT_JOIN = 0x02;
export const INTENT_RESUME = 0x03;

const BYTE_BY_INTENT: Readonly<Record<HelloIntent, number>> = {
  create: INTENT_CREATE,
  join: INTENT_JOIN,
  resume: INTENT_RESUME,
};

const INTENT_BY_BYTE: Readonly<Record<number, HelloIntent>> = {
  [INTENT_CREATE]: 'create',
  [INTENT_JOIN]: 'join',
  [INTENT_RESUME]: 'resume',
};

export const intentToByte = (intent: HelloIntent): number => BYTE_BY_INTENT[intent];

export const byteToIntent = (byte: number): HelloIntent | undefined => INTENT_BY_BYTE[byte];

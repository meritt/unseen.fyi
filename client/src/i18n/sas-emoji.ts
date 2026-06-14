import { type SasEmojiEntry, SAS_POOL } from '@unseen/shared/protocol/sas-pool.ts';

import { lang } from './lang.ts';

export type { SasEmojiEntry };

export const SAS_POOL_SIZE = 256;

export const sasEntryForByte = (byte: number): SasEmojiEntry => {
  if (!Number.isInteger(byte) || byte < 0 || byte >= SAS_POOL_SIZE) {
    throw new Error(`Invalid SAS byte: ${String(byte)}`);
  }
  const entry = SAS_POOL[byte];
  if (entry === undefined) {
    throw new Error(`SAS pool entry missing for byte ${String(byte)}`);
  }
  return entry;
};

export const sasNameForByte = (byte: number): string => {
  const entry = sasEntryForByte(byte);
  return lang.value === 'ru' ? entry.ru : entry.en;
};

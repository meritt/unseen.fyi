import poolFile from './sas-emoji-v1.json' with { type: 'json' };

export type SasEmojiEntry = {
  readonly byte: number;
  readonly emoji: string;
  readonly en: string;
  readonly ru: string;
};

export const SAS_POOL: readonly SasEmojiEntry[] = poolFile.pool;
export const SAS_POOL_RAW: unknown = poolFile.pool;

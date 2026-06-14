import { sha256 } from '@noble/hashes/sha2.js';

import type { Bytes } from './encoding.ts';

export type Sha256Stream = {
  update: (bytes: Bytes) => void;
  digest: () => string;
};

export const createSha256Stream = (): Sha256Stream => {
  const inner = sha256.create();
  let finished = false;

  return {
    update(bytes: Bytes): void {
      if (finished) {
        throw new Error('sha256 stream already finished');
      }
      inner.update(bytes);
    },
    digest(): string {
      if (finished) {
        throw new Error('sha256 stream already finished');
      }
      finished = true;
      return inner.digest().toHex();
    },
  };
};

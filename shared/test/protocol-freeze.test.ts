import { describe, expect, test } from 'bun:test';

import {
  FROZEN_SHA256_OF_FILE_VECTORS,
  FROZEN_SHA256_OF_POOL_ARRAY,
  FROZEN_SHA256_OF_VECTORS,
  hashFrozenArray,
} from '../src/protocol/freeze.ts';
import { SAS_POOL_RAW } from '../src/protocol/sas-pool.ts';
import { TEST_VECTORS_FILE_RAW, TEST_VECTORS_RAW } from '../src/protocol/test-vectors.ts';

describe('frozen protocol artifacts', () => {
  test('SAS emoji pool hash matches the v1 freeze', async () => {
    expect(await hashFrozenArray(SAS_POOL_RAW)).toBe(FROZEN_SHA256_OF_POOL_ARRAY);
  });

  test('Test vectors hash matches the v1 freeze', async () => {
    expect(await hashFrozenArray(TEST_VECTORS_RAW)).toBe(FROZEN_SHA256_OF_VECTORS);
  });

  test('File-transfer test vectors hash matches the v1 freeze', async () => {
    expect(await hashFrozenArray(TEST_VECTORS_FILE_RAW)).toBe(FROZEN_SHA256_OF_FILE_VECTORS);
  });
});

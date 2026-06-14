export const FROZEN_SHA256_OF_POOL_ARRAY =
  'b21314619111e24dfe77bb31ed26758ced7597843dc25d047cbdc6af43e0adce';

export const FROZEN_SHA256_OF_VECTORS =
  '1dc3f662533a70f51b3775ef3271e774222eedb84b5f22f1f9f4cd8b9371e80a';

export const FROZEN_SHA256_OF_FILE_VECTORS =
  '5b16f502c66678234bfd52db117e7ba4e1c504ac961e869e382669db2497bcbd';

const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest).toHex();
};

export const hashFrozenArray = async (value: unknown): Promise<string> =>
  await sha256Hex(JSON.stringify(value));

import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';
import { buildPaddedPng } from './fixtures/png.ts';

test('hash mismatch: receiver tri-invariant verify catches a flipped byte, both sides see failed', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await bob.evaluate(() => {
      const original = crypto.subtle.decrypt.bind(crypto.subtle);
      const state = { applied: false };
      Object.defineProperty(crypto.subtle, 'decrypt', {
        configurable: true,
        writable: true,
        value: async function decryptPatched(
          algo: unknown,
          key: CryptoKey,
          data: BufferSource,
        ): Promise<ArrayBuffer> {
          const plaintext = await original(algo as AlgorithmIdentifier, key, data);
          if (state.applied) {
            return plaintext;
          }
          let kind: number | undefined;
          if (typeof algo === 'object' && algo !== null && 'additionalData' in algo) {
            const aadField = (algo as { additionalData?: unknown }).additionalData;
            let view: Uint8Array | undefined;
            if (aadField instanceof ArrayBuffer) {
              view = new Uint8Array(aadField);
            } else if (ArrayBuffer.isView(aadField)) {
              view = new Uint8Array(
                aadField.buffer as ArrayBuffer,
                aadField.byteOffset,
                aadField.byteLength,
              );
            }
            if (view !== undefined && view.length > 0) {
              kind = view[view.length - 1];
            }
          }
          if (kind === 0x01 && plaintext.byteLength > 14) {
            state.applied = true;
            const view = new Uint8Array(plaintext);
            view[14] = (view[14] ?? 0) ^ 0xff;
            return view.buffer;
          }
          return plaintext;
        },
      });
    });

    const bytes = buildPaddedPng(20 * 1024);
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'tampered.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();

    await expect(bob.getByTestId('system-file_transfer_failed')).toBeVisible({ timeout: 20_000 });
    await expect(alice.getByTestId('system-file_transfer_failed')).toBeVisible({ timeout: 10_000 });

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

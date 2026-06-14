import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';

test('second offer while incomingActive non-null: silently rejected, no second bubble', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'first.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(2048, 0x41),
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await expect(bob.getByTestId('file-bubble-offer')).toHaveCount(1);

    await bob.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileTransfer?: {
              simulateIncomingOffer?: (envelope: {
                readonly kind: 'file_offer';
                readonly tid: string;
                readonly name: string;
                readonly size: number;
              }) => void;
            };
          };
        }
      ).__unseenTest;
      const fn = hook?.fileTransfer?.simulateIncomingOffer;
      if (fn === undefined) {
        throw new Error('simulateIncomingOffer hook missing');
      }
      fn({ kind: 'file_offer', tid: 'aabbccddeeff0011', name: 'second.bin', size: 1024 });
    });

    await bob.waitForTimeout(500);
    await expect(bob.getByTestId('file-bubble-offer')).toHaveCount(1);
    await expect(bob.locator('[data-tid="aabbccddeeff0011"]')).toHaveCount(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

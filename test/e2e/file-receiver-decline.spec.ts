import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';

test('receiver declines pending offer: sender sees cancelled bubble; receiver clears', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'declined.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(2048, 0x41),
    });
    await expect(alice.getByTestId('attached-chip')).toBeVisible();
    await alice.getByTestId('send').click();

    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });

    await bob.getByTestId('file-decline').click();

    await expect(alice.getByTestId('system-file_transfer_cancelled')).toBeVisible({
      timeout: 10_000,
    });
    await alice.waitForFunction(
      () => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: {
              fileState?: { transferActive?: { value: unknown } };
            };
          }
        ).__unseenTest;
        return hook?.fileState?.transferActive?.value === null;
      },
      { timeout: 5000 },
    );

    await bob.waitForFunction(
      () => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: {
              fileState?: { incomingActive?: { value: unknown } };
            };
          }
        ).__unseenTest;
        return hook?.fileState?.incomingActive?.value === null;
      },
      { timeout: 5000 },
    );
    await expect(bob.getByTestId('file-bubble-offer')).toHaveCount(0);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

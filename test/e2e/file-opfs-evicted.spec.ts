import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';
import { buildMinimalPng } from './fixtures/png.ts';

test('OPFS-evicted attachment: clicking Download morphs the bubble to `unavailable`', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'evicted.png',
      mimeType: 'image/png',
      buffer: buildMinimalPng(),
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(bob.getByTestId('file-bubble-attachment')).toBeVisible({ timeout: 15_000 });

    await bob.evaluate(() => {
      (FileSystemFileHandle.prototype as any).getFile = function (): Promise<File> {
        const err = new DOMException('File not found', 'NotFoundError');
        return Promise.reject(err);
      };
    });

    await bob.getByTestId('file-download').click();

    await expect(bob.getByTestId('file-bubble-attachment')).toHaveCount(0, { timeout: 5000 });
    await expect(bob.getByTestId('file-download')).toHaveCount(0);
    await expect(bob.getByTestId('file-message')).toBeAttached();
    await expect(bob.getByTestId('file-message')).toHaveClass(/chat__msg--file-empty/u);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

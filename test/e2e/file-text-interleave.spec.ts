import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';
import { buildMinimalPng } from './fixtures/png.ts';

test('text message sent during in-flight file transfer is delivered to the peer', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'interleave.png',
      mimeType: 'image/png',
      buffer: buildMinimalPng(),
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();

    await alice.getByTestId('composer').fill('hello during transfer');
    await alice.getByTestId('send').click();
    await alice.waitForTimeout(50);

    await expect(bob.getByTestId('messages')).toContainText('hello during transfer', {
      timeout: 10_000,
    });

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

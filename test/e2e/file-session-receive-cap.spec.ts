import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';
import { buildMinimalPng } from './fixtures/png.ts';

test('session-receive cap auto-declines with file_session_cap_reached fired once', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await bob.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { sessionReceivedBytes?: { value: number } };
          };
        }
      ).__unseenTest;
      const signal = hook?.fileState?.sessionReceivedBytes;
      if (signal === undefined) {
        throw new Error('sessionReceivedBytes signal missing');
      }
      signal.value = 500 * 1024 * 1024 - 1;
    });

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'capped-1.png',
      mimeType: 'image/png',
      buffer: buildMinimalPng(),
    });
    await alice.getByTestId('send').click();

    await expect(bob.getByTestId('system-file_session_cap_reached')).toBeVisible({
      timeout: 10_000,
    });
    await expect(bob.getByTestId('file-bubble-offer')).toHaveCount(0);

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'capped-2.png',
      mimeType: 'image/png',
      buffer: buildMinimalPng(),
    });
    await alice.getByTestId('send').click();

    await bob.waitForTimeout(500);

    const cnt = await bob.getByTestId('system-file_session_cap_reached').count();
    expect(cnt).toBe(1);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

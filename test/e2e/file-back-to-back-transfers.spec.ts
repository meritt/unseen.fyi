import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';
import { buildPaddedPng } from './fixtures/png.ts';

test.setTimeout(90_000);

test('back-to-back transfers complete with no SAH lock InvalidStateError', async ({ browser }) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    const bobErrors: string[] = [];
    bob.on('console', (msg) => {
      if (msg.type() === 'error') {
        bobErrors.push(msg.text());
      }
    });

    const fileA = buildPaddedPng(10 * 1024);
    const fileB = buildPaddedPng(12 * 1024);

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'first.png',
      mimeType: 'image/png',
      buffer: fileA,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(bob.getByTestId('file-bubble-attachment').first()).toBeVisible({
      timeout: 15_000,
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
      { timeout: 10_000 },
    );

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'second.png',
      mimeType: 'image/png',
      buffer: fileB,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();

    await expect(bob.getByTestId('file-bubble-attachment')).toHaveCount(2, { timeout: 15_000 });

    const sahErrors = bobErrors.filter((line) => /InvalidStateError|SyncAccessHandle/iu.test(line));
    expect(sahErrors).toEqual([]);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

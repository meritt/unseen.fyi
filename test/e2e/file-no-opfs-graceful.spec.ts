import { expect, test } from '@playwright/test';

import { closeAll, waitForActive } from './fixtures/file-helpers.ts';

test('attach button hidden when OPFS getDirectory rejects', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.waitForFunction(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { fileTransferSupported?: { value: boolean } };
          };
        }
      ).__unseenTest;
      return hook?.fileState?.fileTransferSupported !== undefined;
    });
    await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: {
              fileTransferSupported?: { value: boolean };
              fileTransferReady?: { value: boolean };
            };
          };
        }
      ).__unseenTest;
      const supported = hook?.fileState?.fileTransferSupported;
      const ready = hook?.fileState?.fileTransferReady;
      if (supported === undefined || ready === undefined) {
        throw new Error('fileState hooks missing');
      }
      supported.value = false;
      ready.value = false;
    });

    await expect(alice.getByTestId('composer-attach')).toHaveCount(0);

    await alice.getByTestId('composer').fill('still works');
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('messages').locator('.chat__msg')).toContainText('still works');

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

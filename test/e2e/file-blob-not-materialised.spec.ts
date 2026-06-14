import { expect, test } from '@playwright/test';

import { closeAll } from './fixtures/file-helpers.ts';
import { buildMinimalPng } from './fixtures/png.ts';

test('Download path does not call Blob.prototype.arrayBuffer', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await bob.addInitScript(() => {
      const w = globalThis as unknown as { __arrayBufferCalled?: boolean };
      w.__arrayBufferCalled = false;
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function arrayBufferTracked(): Promise<ArrayBuffer> {
        (globalThis as unknown as { __arrayBufferCalled?: boolean }).__arrayBufferCalled = true;
        return original.call(this);
      };
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });

    await bob.waitForFunction(
      () => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: {
              fileState?: {
                fileTransferReady?: { value: boolean };
                currentOpaqueDir?: { value: string | undefined };
              };
            };
          }
        ).__unseenTest;
        const state = hook?.fileState;
        return (
          state?.fileTransferReady?.value === true &&
          typeof state.currentOpaqueDir?.value === 'string'
        );
      },
      { timeout: 10_000 },
    );
    await alice.waitForFunction(
      () => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: { fileState?: { fileTransferReady?: { value: boolean } } };
          }
        ).__unseenTest;
        return hook?.fileState?.fileTransferReady?.value === true;
      },
      { timeout: 10_000 },
    );

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'tiny.png',
      mimeType: 'image/png',
      buffer: buildMinimalPng(),
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(bob.getByTestId('file-bubble-attachment')).toBeVisible({ timeout: 15_000 });

    await bob.evaluate(() => {
      (globalThis as unknown as { __arrayBufferCalled?: boolean }).__arrayBufferCalled = false;
    });

    await bob.getByTestId('file-download').click();
    await bob.waitForTimeout(200);

    const called = await bob.evaluate(
      () => (globalThis as unknown as { __arrayBufferCalled?: boolean }).__arrayBufferCalled,
    );
    expect(called).toBe(false);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

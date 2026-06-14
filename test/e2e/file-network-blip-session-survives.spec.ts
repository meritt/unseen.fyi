import { type BrowserContext, expect, type Page, test } from '@playwright/test';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  '__unseenTest dev hook is Chromium-only',
);

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const waitForFileReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(
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
};

test('RAM-mode WS drop terminates session; fresh page load brings up a new clean session', async ({
  browser,
}) => {
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
    await waitForFileReady(alice);

    const bytes = Buffer.alloc(64 * 1024);
    bytes[0] = 0x89;
    bytes[1] = 0x50;
    bytes[2] = 0x4e;
    bytes[3] = 0x47;
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'session-1.bin',
      mimeType: 'application/octet-stream',
      buffer: bytes,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(alice.getByTestId('file-bubble-inflight')).toBeVisible({ timeout: 10_000 });

    await alice.evaluate(() => {
      (
        globalThis as { __unseenTest?: { forceCloseWs?: () => void } }
      ).__unseenTest?.forceCloseWs?.();
    });

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 15_000 },
    );

    await alice.close();
    await bob.close();
    const alice2 = await aliceContext.newPage();
    const bob2 = await bobContext.newPage();
    await alice2.goto('/');
    await alice2.getByTestId('create-room').click();
    await alice2.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob2.goto(alice2.url());
    await waitForActive(alice2);
    await waitForActive(bob2);
    await waitForFileReady(alice2);
    await waitForFileReady(bob2);

    expect(await alice2.getByTestId('system-file_transfer_failed').count()).toBe(0);
    expect(await bob2.getByTestId('system-file_transfer_failed').count()).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

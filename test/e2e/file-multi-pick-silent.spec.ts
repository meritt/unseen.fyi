import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const forceFileTransferReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => {
    const hook = (
      globalThis as unknown as {
        __unseenTest?: {
          fileState?: { fileTransferSupported?: { value: boolean } };
        };
      }
    ).__unseenTest;
    return hook?.fileState?.fileTransferSupported !== undefined;
  });
  await page.evaluate(() => {
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
      throw new Error('file-state hooks missing');
    }
    supported.value = true;
    ready.value = true;
  });
};

test('file-input has multiple=false so the browser-level UI enforces single-pick', async ({
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
    await forceFileTransferReady(alice);

    const input = alice.locator('[data-testid="file-input"]');
    await expect(input).not.toHaveAttribute('multiple', /.*/);
    let threw = false;
    try {
      await input.setInputFiles([
        { name: 'first.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('AAAA') },
        { name: 'second.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('BBBB') },
      ]);
    } catch (error) {
      threw = error instanceof Error && /multiple/iu.test(error.message);
    }
    expect(threw).toBe(true);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('zero-byte file pick fires file_transfer_failed system-event and skips chip', async ({
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
    await forceFileTransferReady(alice);

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'empty.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(0),
    });

    await expect(alice.getByTestId('attached-chip')).toHaveCount(0);
    await expect(alice.getByTestId('system-file_transfer_failed')).toBeVisible();
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

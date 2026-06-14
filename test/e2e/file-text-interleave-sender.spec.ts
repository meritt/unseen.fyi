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

test('typing text + attaching a file fires both on one Send', async ({ browser }) => {
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

    await alice.getByTestId('composer').fill('hello from alice');

    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'interleave.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(2048, 0x42),
    });
    await expect(alice.getByTestId('attached-chip')).toBeVisible();

    await alice.getByTestId('send').click();

    await expect(bob.getByTestId('messages').locator('.chat__msg').first()).toContainText(
      'hello from alice',
    );

    await expect(alice.getByTestId('attached-chip')).toHaveCount(0);
    await alice.waitForFunction(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: {
              transferActive?: {
                value: { readonly phase?: string } | null;
              };
            };
          };
        }
      ).__unseenTest;
      const phase = hook?.fileState?.transferActive?.value?.phase;
      return phase === 'offered' || phase === 'sending' || phase === 'verifying';
    });
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

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

test('attached file chip appears after pick and disappears on remove', async ({ browser }) => {
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
      name: 'hello.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello world'),
    });

    await expect(alice.getByTestId('attached-chip')).toBeVisible();
    await expect(alice.getByTestId('attached-name')).toHaveText('hello.txt');

    await alice.getByTestId('attached-remove').click();
    await expect(alice.getByTestId('attached-chip')).toHaveCount(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('clearing transferActive returns the attach button to enabled', async ({ browser }) => {
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

    await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { transferActive?: { value: unknown } };
          };
        }
      ).__unseenTest;
      const signal = hook?.fileState?.transferActive;
      if (signal === undefined) {
        throw new Error('transferActive signal missing');
      }
      signal.value = {
        tid: 'feedfacefeedface',
        phase: 'offered',
        name: 'busy.bin',
        size: 2048,
        file: new File([new Uint8Array(2048)], 'busy.bin'),
        abort: new AbortController().signal,
      };
    });
    await expect(alice.getByTestId('composer-attach')).toBeDisabled();

    await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { transferActive?: { value: unknown } };
          };
        }
      ).__unseenTest;
      const signal = hook?.fileState?.transferActive;
      if (signal === undefined) {
        throw new Error('transferActive signal missing');
      }
      signal.value = null;
    });

    await expect(alice.getByTestId('composer-attach')).toBeEnabled();
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

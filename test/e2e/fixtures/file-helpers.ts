import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';

export const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

export const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

export const forceFileTransferReady = async (page: Page): Promise<void> => {
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
            currentOpaqueDir?: { value: string | undefined };
          };
        };
      }
    ).__unseenTest;
    const supported = hook?.fileState?.fileTransferSupported;
    const ready = hook?.fileState?.fileTransferReady;
    const dir = hook?.fileState?.currentOpaqueDir;
    if (supported === undefined || ready === undefined || dir === undefined) {
      throw new Error('file-state hooks missing');
    }
    supported.value = true;
    ready.value = true;
    dir.value ??= 'X_TbN9q4-pZ';
  });
};

export const waitForFileTransferReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(
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
      const ready = hook?.fileState?.fileTransferReady?.value === true;
      const dir = hook?.fileState?.currentOpaqueDir?.value;
      return ready && typeof dir === 'string';
    },
    { timeout: 10_000 },
  );
};

export const openActiveRoom = async (
  browser: Browser,
): Promise<{
  readonly aliceContext: BrowserContext;
  readonly bobContext: BrowserContext;
  readonly alice: Page;
  readonly bob: Page;
}> => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await alice.goto('/');
  await alice.getByTestId('create-room').click();
  await alice.waitForURL(/\/r402#[\w-]{43}$/u);
  await bob.goto(alice.url());
  await waitForActive(alice);
  await waitForActive(bob);
  await waitForFileTransferReady(alice);
  await waitForFileTransferReady(bob);
  return { aliceContext, bobContext, alice, bob };
};

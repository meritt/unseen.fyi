import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

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

const openActiveRoom = async (
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
  return { aliceContext, bobContext, alice, bob };
};

test('attach button hidden until session reaches ACTIVE', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  try {
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'WAITING_FOR_PEER',
      { timeout: 5000 },
    );
    await forceFileTransferReady(alice);
    await expect(alice.getByTestId('composer-attach')).toHaveCount(0);
    const textarea = alice.getByTestId('composer');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();
    const bobContext = await browser.newContext();
    try {
      const bob = await bobContext.newPage();
      await bob.goto(alice.url());
      await waitForActive(alice);
      await waitForActive(bob);
      await forceFileTransferReady(alice);
      await expect(alice.getByTestId('composer-attach')).toBeVisible();
    } finally {
      await bobContext.close();
    }
  } finally {
    await aliceContext.close();
  }
});

test('attach button is enabled when capability gates are satisfied', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await forceFileTransferReady(alice);
    await expect(alice.getByTestId('composer-attach')).toBeEnabled();
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('attach button disabled (busy) while a transfer is in flight', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
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
        tid: '0123456789abcdef',
        phase: 'offered',
        name: 'busy.bin',
        size: 1024,
        file: new File([new Uint8Array(1024)], 'busy.bin'),
        abort: new AbortController().signal,
      };
    });
    const button = alice.getByTestId('composer-attach');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('data-tooltip', /transfer/i);
    await expect(button).toHaveAttribute('aria-description', /transfer/i);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('attach button hidden when OPFS is unsupported', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
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
            fileState?: { fileTransferSupported?: { value: boolean } };
          };
        }
      ).__unseenTest;
      const signal = hook?.fileState?.fileTransferSupported;
      if (signal === undefined) {
        throw new Error('fileTransferSupported signal missing');
      }
      signal.value = false;
    });
    await expect(alice.getByTestId('composer-attach')).toHaveCount(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('bidi filename is sanitized in composer chip preview', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await forceFileTransferReady(alice);
    const attackName = 'inno‮exe.cnep';
    await alice.getByTestId('file-input').setInputFiles({
      name: attackName,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0x00]),
    });
    const chip = alice.getByTestId('attached-name');
    await expect(chip).toBeVisible();
    const text = (await chip.textContent()) ?? '';
    expect(text).not.toContain('‮');
    expect(text).toBe('innoexe.cnep');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('attach button shows initializing state when ready signal is false', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await alice.waitForFunction(() => {
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
        throw new Error('hooks missing');
      }
      supported.value = true;
      ready.value = false;
    });
    const button = alice.getByTestId('composer-attach');
    await expect(button).toBeDisabled();
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

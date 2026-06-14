import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

import { scan } from './_a11y-scan.ts';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'file-a11y matches the Chromium-only file-* matrix',
);

test.describe.configure({ mode: 'serial' });

const COMPOSER_TOUCH_TARGET_MIN = 44;
const BUBBLE_TOUCH_TARGET_MIN = 24;

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
        __unseenTest?: { fileState?: { fileTransferSupported?: { value: boolean } } };
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

const openActiveRoom = async (
  browser: Browser,
  options: { readonly reducedMotion?: 'reduce' | 'no-preference' } = {},
): Promise<{
  readonly aliceContext: BrowserContext;
  readonly bobContext: BrowserContext;
  readonly alice: Page;
  readonly bob: Page;
}> => {
  const { reducedMotion } = options;
  const aliceContext = await browser.newContext(
    reducedMotion === undefined ? undefined : { reducedMotion },
  );
  const bobContext = await browser.newContext(
    reducedMotion === undefined ? undefined : { reducedMotion },
  );
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await alice.goto('/');
  await alice.getByTestId('create-room').click();
  await alice.waitForURL(/\/r402#[\w-]{43}$/u);
  await bob.goto(alice.url());
  await waitForActive(alice);
  await waitForActive(bob);
  await forceFileTransferReady(alice);
  await forceFileTransferReady(bob);
  return { aliceContext, bobContext, alice, bob };
};

const assertTouchTargets = async (page: Page): Promise<void> => {
  const GROUPS: ReadonlyArray<{ readonly min: number; readonly selectors: readonly string[] }> = [
    {
      min: COMPOSER_TOUCH_TARGET_MIN,
      selectors: ['[data-testid="composer-attach"]', '[data-testid="attached-remove"]'],
    },
    {
      min: BUBBLE_TOUCH_TARGET_MIN,
      selectors: [
        '[data-testid="file-accept"]',
        '[data-testid="file-decline"]',
        '[data-testid="file-cancel"]',
      ],
    },
  ];
  for (const { min, selectors } of GROUPS) {
    for (const selector of selectors) {
      const elements = await page.locator(selector).all();
      for (const element of elements) {
        const visible = await element.isVisible();
        if (!visible) {
          continue;
        }
        const box = await element.boundingBox();
        if (box === null) {
          continue;
        }
        const tag = await element.evaluate((el) => el.tagName.toLowerCase());
        const testid = await element.getAttribute('data-testid');
        expect(
          box.width,
          `${tag}[data-testid=${testid ?? '?'}] width must be ≥${String(min)}px`,
        ).toBeGreaterThanOrEqual(min - 1);
        expect(
          box.height,
          `${tag}[data-testid=${testid ?? '?'}] height must be ≥${String(min)}px`,
        ).toBeGreaterThanOrEqual(min - 1);
      }
    }
  }
};

test('a11y: composer with enabled attach button passes axe + touch-target', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await expect(alice.getByTestId('composer-attach')).toBeEnabled();
    await scan(alice);
    await assertTouchTargets(alice);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: composer with attached chip passes axe + touch-target', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'a11y-chip.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(2048, 0x21),
    });
    await expect(alice.getByTestId('attached-chip')).toBeVisible();
    await scan(alice);
    await assertTouchTargets(alice);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: incoming offer-pending bubble passes axe + touch-target', async ({ browser }) => {
  const { aliceContext, bobContext, bob } = await openActiveRoom(browser);
  try {
    await bob.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { incomingActive?: { value: unknown } };
            appendFileMessage?: (tid: string, direction: 'in' | 'out', iso: string) => void;
          };
        }
      ).__unseenTest;
      const incoming = hook?.fileState?.incomingActive;
      const appendFileMessage = hook?.appendFileMessage;
      if (incoming === undefined || appendFileMessage === undefined) {
        throw new Error('a11y hooks missing');
      }
      incoming.value = {
        tid: '0123456789abcdef',
        phase: 'offer-pending',
        name: 'remote.bin',
        size: 4096,
      };
      appendFileMessage('0123456789abcdef', 'in', new Date().toISOString());
    });
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 5000 });
    await scan(bob);
    await assertTouchTargets(bob);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: sender in-flight bubble passes axe + touch-target', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { transferActive?: { value: unknown } };
            appendFileMessage?: (tid: string, direction: 'in' | 'out', iso: string) => void;
          };
        }
      ).__unseenTest;
      const transfer = hook?.fileState?.transferActive;
      const appendFileMessage = hook?.appendFileMessage;
      if (transfer === undefined || appendFileMessage === undefined) {
        throw new Error('a11y hooks missing');
      }
      const stubWorker = { postMessage: (): void => {}, terminate: (): void => {} };
      transfer.value = {
        tid: 'feedfacefeedface',
        phase: 'sending',
        name: 'sending.bin',
        size: 32_768,
        sentBytes: 8192,
        worker: stubWorker,
        abort: new AbortController().signal,
      };
      appendFileMessage('feedfacefeedface', 'out', new Date().toISOString());
    });
    await expect(alice.getByTestId('file-bubble-inflight')).toBeVisible({ timeout: 5000 });
    await scan(alice);
    await assertTouchTargets(alice);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: sender verifying bubble passes axe + touch-target', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { transferActive?: { value: unknown } };
            appendFileMessage?: (tid: string, direction: 'in' | 'out', iso: string) => void;
          };
        }
      ).__unseenTest;
      const transfer = hook?.fileState?.transferActive;
      const appendFileMessage = hook?.appendFileMessage;
      if (transfer === undefined || appendFileMessage === undefined) {
        throw new Error('a11y hooks missing');
      }
      transfer.value = {
        tid: 'cafef00dcafef00d',
        phase: 'verifying',
        name: 'verify.bin',
        size: 32_768,
        abort: new AbortController().signal,
      };
      appendFileMessage('cafef00dcafef00d', 'out', new Date().toISOString());
    });
    await expect(alice.getByTestId('file-bubble-verifying')).toBeVisible({ timeout: 5000 });
    await scan(alice);
    await assertTouchTargets(alice);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: file_transfer_failed system bubble passes axe + touch-target', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            appendSystemMessage?: (event: string, iso: string) => void;
          };
        }
      ).__unseenTest;
      const append = hook?.appendSystemMessage;
      if (append === undefined) {
        throw new Error('appendSystemMessage hook missing');
      }
      append('file_transfer_failed', new Date().toISOString());
    });
    await expect(alice.getByTestId('system-file_transfer_failed')).toBeVisible({ timeout: 5000 });
    await scan(alice);
    await assertTouchTargets(alice);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: file UI renders under prefers-reduced-motion: reduce', async ({ browser }) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser, {
    reducedMotion: 'reduce',
  });
  try {
    await expect(alice.getByTestId('composer-attach')).toBeEnabled();
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'rm.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(1024, 0x55),
    });
    await expect(alice.getByTestId('attached-chip')).toBeVisible();
    await scan(alice);
    await assertTouchTargets(alice);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

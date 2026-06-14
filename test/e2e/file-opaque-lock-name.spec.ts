import { expect, test } from '@playwright/test';

import { closeAll, waitForActive } from './fixtures/file-helpers.ts';

test('navigator.locks.request is invoked with opaque names; no branded substrings', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const sink = globalThis as unknown as { __lockNames__: string[] };
      sink.__lockNames__ = [];
      const proto = Object.getPrototypeOf(navigator.locks) as LockManager;
      const original = proto.request;
      const patched = {
        request(this: LockManager, name: string, ...rest: readonly unknown[]): unknown {
          sink.__lockNames__.push(name);
          return Reflect.apply(original, this, [name, ...rest]);
        },
      };
      Object.defineProperty(proto, 'request', {
        value: patched.request,
        writable: true,
        configurable: true,
      });
    });
    await page.goto('/');
    await page.getByTestId('create-room').click();
    await page.waitForURL(/\/r402#[\w-]{43}$/u);
    await page.waitForSelector('[data-testid="status"][data-state="WAITING_FOR_PEER"]', {
      timeout: 10_000,
    });
    await page.waitForFunction(
      () => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: {
              fileState?: { fileTransferReady?: { value: boolean } };
            };
          }
        ).__unseenTest;
        return hook?.fileState?.fileTransferReady?.value === true;
      },
      { timeout: 10_000 },
    );
    const captured = await page.evaluate(
      () => (globalThis as unknown as { __lockNames__: string[] }).__lockNames__,
    );
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const name of captured) {
      expect(name).toMatch(/^[\w-]{11}$/u);
      const lower = name.toLowerCase();
      expect(lower).not.toContain('unseen');
      expect(lower).not.toContain('opfs');
      expect(lower).not.toContain('lock');
      expect(lower).not.toContain('transfer');
      expect(lower).not.toContain('room');
      expect(lower).not.toContain('file');
    }
  } finally {
    await closeAll(context);
  }
});

test('OPFS_LOCK_NAME exported from `__unseenTest` matches the opaque pattern', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.getByTestId('create-room').click();
    await page.waitForURL(/\/r402#[\w-]{43}$/u);
    await waitForActive(page).catch(async () => {
      await page.waitForFunction(() => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: { fileState?: { OPFS_LOCK_NAME?: unknown } };
          }
        ).__unseenTest;
        return typeof hook?.fileState?.OPFS_LOCK_NAME === 'string';
      });
    });
    const lockName = await page.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: { fileState?: { OPFS_LOCK_NAME?: string } };
        }
      ).__unseenTest;
      return hook?.fileState?.OPFS_LOCK_NAME;
    });
    expect(lockName).toMatch(/^[\w-]{11}$/u);
    const lower = (lockName ?? '').toLowerCase();
    expect(lower).not.toContain('unseen');
    expect(lower).not.toContain('opfs');
    expect(lower).not.toContain('lock');
    expect(lower).not.toContain('transfer');
  } finally {
    await closeAll(context);
  }
});

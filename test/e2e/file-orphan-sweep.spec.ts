import { expect, test } from '@playwright/test';

import { closeAll } from './fixtures/file-helpers.ts';

test('boot-sweep removes orphan opaque OPFS dirs while preserving the current session dir', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const ORPHAN_NAME = 'aBcD3-EfGh7';
    await page.addInitScript((orphan: string) => {
      const root = globalThis as unknown as {
        __orphanSeeded__?: { ok: boolean; err?: string };
      };
      root.__orphanSeeded__ = { ok: false };
      void (async () => {
        try {
          const rootDir = await navigator.storage.getDirectory();
          await rootDir.getDirectoryHandle(orphan, { create: true });
          root.__orphanSeeded__ = { ok: true };
        } catch (err) {
          root.__orphanSeeded__ = { ok: false, err: String(err) };
        }
      })();
    }, ORPHAN_NAME);

    await page.goto('/');
    await page.getByTestId('create-room').click();
    await page.waitForURL(/\/r402#[\w-]{43}$/u);

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

    const result = await page.evaluate(async () => {
      const root = globalThis as unknown as {
        __orphanSeeded__?: { ok: boolean; err?: string };
        __unseenTest?: {
          fileState?: { currentOpaqueDir?: { value: string | undefined } };
        };
      };
      const entries: string[] = [];
      const rootDir = await navigator.storage.getDirectory();
      const iter = (
        rootDir as unknown as { values: () => AsyncIterable<{ name: string }> }
      ).values();
      for await (const entry of iter) {
        entries.push(entry.name);
      }
      return {
        seeded: root.__orphanSeeded__,
        entries,
        currentDir: root.__unseenTest?.fileState?.currentOpaqueDir?.value,
      };
    });

    expect(result.seeded?.ok).toBe(true);
    expect(result.entries).not.toContain(ORPHAN_NAME);
    expect(result.currentDir).toBeDefined();
    expect(result.entries).toContain(result.currentDir);
  } finally {
    await closeAll(context);
  }
});

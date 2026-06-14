import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';

test.setTimeout(60_000);

test('large file Download: `showSaveFilePicker` invoked with suggestedName matching original', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await bob.evaluate(() => {
      type CapturedCall = {
        readonly suggestedName?: string;
        readonly bytes: number;
      };
      const captured: CapturedCall[] = [];
      (
        globalThis as unknown as { __capturedSaveCalls: readonly CapturedCall[] }
      ).__capturedSaveCalls = captured;

      (
        globalThis as unknown as {
          showSaveFilePicker: (opts: { suggestedName?: string }) => Promise<unknown>;
        }
      ).showSaveFilePicker = async (opts) => {
        const call: { suggestedName?: string; bytes: number } = { bytes: 0 };
        if (opts.suggestedName !== undefined) {
          call.suggestedName = opts.suggestedName;
        }
        captured.push(call);
        return {
          createWritable: async () => ({
            write: async (blob: Blob): Promise<void> => {
              call.bytes += blob.size;
            },
            close: async (): Promise<void> => undefined,
          }),
        };
      };
    });

    const payload = Buffer.alloc(30 * 1024);
    crypto.getRandomValues(payload);
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      buffer: payload,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(bob.getByTestId('file-bubble-attachment')).toBeVisible({ timeout: 45_000 });

    await bob.getByTestId('file-download').click();

    await bob.waitForFunction(
      () => {
        const captured = (
          globalThis as unknown as {
            __capturedSaveCalls?: ReadonlyArray<{ suggestedName?: string; bytes: number }>;
          }
        ).__capturedSaveCalls;
        return (captured?.length ?? 0) >= 1 && (captured?.[0]?.bytes ?? 0) > 0;
      },
      { timeout: 5000 },
    );
    const calls = await bob.evaluate(
      () =>
        (
          globalThis as unknown as {
            __capturedSaveCalls?: ReadonlyArray<{ suggestedName?: string; bytes: number }>;
          }
        ).__capturedSaveCalls ?? [],
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.suggestedName).toBe('big.bin');
    expect(calls[0]?.bytes).toBeGreaterThan(0);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

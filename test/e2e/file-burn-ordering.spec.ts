import { type BrowserContext, expect, test } from '@playwright/test';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'signalUnknownCredential is Chromium-only',
);

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

test('burn during in-flight transfer: sync resource cleanup fires before signal + removeItem', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    const order: Array<{ event: string; t: number }> = [];
    await alice.exposeFunction('__stampOrder', (event: string, t: number) => {
      order.push({ event, t });
    });

    await alice.addInitScript(() => {
      type Stamper = (event: string, t: number) => void;
      const w = globalThis as { __stampOrder?: Stamper };
      const stamp = (event: string): void => {
        w.__stampOrder?.(event, performance.now());
      };
      const origRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key: string): void {
        stamp('removeItem');
        return origRemove.call(this, key);
      };
      const origClose = WebSocket.prototype.close;
      let wsClosed = false;
      WebSocket.prototype.close = function (code?: number, reason?: string): void {
        if (!wsClosed) {
          wsClosed = true;
          stamp('wsClose');
        }
        return origClose.call(this, code, reason);
      };
      if (typeof globalThis.PublicKeyCredential === 'function') {
        const orig = globalThis.PublicKeyCredential.signalUnknownCredential.bind(
          globalThis.PublicKeyCredential,
        );
        globalThis.PublicKeyCredential.signalUnknownCredential = async (opts) => {
          stamp('signal');
          await orig(opts);
          return undefined;
        };
      }
      const origWorkerTerm = Worker.prototype.terminate;
      Worker.prototype.terminate = function (): void {
        stamp('workerTerminate');
        return origWorkerTerm.call(this);
      };
      const origRevoke = URL.revokeObjectURL;
      URL.revokeObjectURL = function (url: string): void {
        stamp('revokeObjectURL');
        return origRevoke.call(this, url);
      };
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });
    await alice.waitForFunction(
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
    await bob.waitForFunction(
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

    // 4MB keeps the transfer in phase='sending' long enough for the runner to observe under load
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'burn-probe.bin',
      mimeType: 'application/octet-stream',
      buffer: bytes,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(alice.getByTestId('file-bubble-inflight')).toBeVisible({ timeout: 10_000 });

    const beforeBurnLen = order.length;
    const phaseAtBurn = await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: { fileState?: { transferActive?: { value: { phase?: string } | null } } };
        }
      ).__unseenTest;
      return hook?.fileState?.transferActive?.value?.phase ?? null;
    });
    expect(phaseAtBurn).toBe('sending');

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });

    // CDP binding events arrive in order, so the last stamp (removeItem) implies every earlier one landed
    await expect
      .poll(
        () => {
          const events = new Set(order.slice(beforeBurnLen).map((entry) => entry.event));
          return events.has('wsClose') && events.has('removeItem');
        },
        { timeout: 5000 },
      )
      .toBe(true);

    const burnEvents = order.slice(beforeBurnLen);
    const find = (event: string): number => {
      const entry = burnEvents.find((e) => e.event === event);
      return entry?.t ?? Number.POSITIVE_INFINITY;
    };

    const wsAt = find('wsClose');
    const signalAt = find('signal');
    const removeAt = find('removeItem');
    const workerTermAt = find('workerTerminate');
    const revokeAt = find('revokeObjectURL');

    expect(wsAt).toBeLessThan(removeAt);
    if (signalAt !== Number.POSITIVE_INFINITY) {
      expect(wsAt).toBeLessThan(signalAt);
      expect(signalAt).toBeLessThanOrEqual(removeAt);
    }

    if (workerTermAt !== Number.POSITIVE_INFINITY) {
      expect(workerTermAt).toBeLessThanOrEqual(removeAt);
    }
    if (revokeAt !== Number.POSITIVE_INFINITY) {
      expect(revokeAt).toBeLessThanOrEqual(removeAt);
    }

    void phaseAtBurn;
    void burnEvents;
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

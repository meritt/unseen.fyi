import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('peer-exit-fatal-no-number: a malformed RELAY frame triggers fatal flow with no countdown digits', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.addInitScript(`
      const RELAY_TYPE = 0x05;
      const origSend = globalThis.WebSocket.prototype.send;
      let corruptCounter = 0;
      globalThis.WebSocket.prototype.send = function(data) {
        if (data instanceof ArrayBuffer) {
          const view = new Uint8Array(data);
          if (view.length > 16 && view[0] === RELAY_TYPE && corruptCounter < 1) {
            view[view.length - 1] ^= 0xff;
            corruptCounter += 1;
          }
        }
        return origSend.call(this, data);
      };
    `);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('composer').fill('attacker tampers with this');
    await alice.getByTestId('send').click();

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 10_000 },
    );
    await expect(bob.getByTestId('system-session_ended')).toBeVisible();

    const overlay = (await bob.getByTestId('system-session_ended').textContent()) ?? '';
    expect(overlay).not.toMatch(/[0-9]+:[0-9]{2}/u);
    expect(overlay.toLowerCase()).not.toContain('decrypt_failed');
    expect(overlay.toLowerCase()).not.toContain('counter_gap');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test.skip('sas-mismatch: deferred — requires a stand-alone WS MITM proxy with independent X25519 handshakes', () =>
  undefined);

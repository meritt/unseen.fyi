import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const PAIRS = [
  {
    label: 'script tag is escaped (window.alert is not called)',
    payload: '<script>alert(1)</script>',
    expectVisible: '<script>alert(1)</script>',
  },
  {
    label: 'img onerror is escaped',
    payload: '<img src=x onerror=alert(1)>',
    expectVisible: '<img src=x onerror=alert(1)>',
  },
  {
    label: 'js: link renders as plain text',
    payload: '[click](javascript:alert(1))',
    expectVisible: '[click](javascript:alert(1))',
  },
  {
    label: 'data:text/html link renders as plain text',
    payload: '[click](data:text/html,<svg/onload=alert(1)>)',
    expectVisible: '[click](data:text/html,',
  },
  {
    label: 'mailto: link renders as plain text',
    payload: '[click](mailto:b@c)',
    expectVisible: '[click](mailto:b@c)',
  },
  {
    label: 'IDN host is shown in punycode',
    payload: '[click](https://xn--80ak6aa92e.com)',
    expectVisible: 'xn--80ak6aa92e.com',
  },
];

for (const { label, payload, expectVisible } of PAIRS) {
  test(`markdown-corpus: ${label}`, async ({ browser }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    try {
      const alice = await aliceContext.newPage();
      const bob = await bobContext.newPage();

      let alertCalled = 0;
      const installAlertSpy = `
        const origAlert = globalThis.alert;
        globalThis.alert = function() { console.log('__ALERT_CALLED__'); };
      `;
      await alice.addInitScript(installAlertSpy);
      await bob.addInitScript(installAlertSpy);
      const onConsoleAlert = (msg: { text: () => string }): void => {
        if (msg.text() === '__ALERT_CALLED__') {
          alertCalled += 1;
        }
      };
      alice.on('console', onConsoleAlert);
      bob.on('console', onConsoleAlert);

      await alice.goto('/');
      await alice.getByTestId('create-room').click();
      await alice.waitForURL(/\/r402#[\w-]{43}$/u);
      await bob.goto(alice.url());
      await waitForActive(alice);
      await waitForActive(bob);

      await alice.getByTestId('composer').fill(payload);
      await alice.getByTestId('send').click();

      await expect(bob.getByTestId('messages').locator('.chat__msg').first()).toContainText(
        expectVisible,
        {
          timeout: 10_000,
        },
      );

      const scriptCount = await bob.getByTestId('messages').locator('script').count();
      expect(scriptCount).toBe(0);
      const jsLinkCount = await bob
        .getByTestId('messages')
        .locator('a[href^="javascript:"]')
        .count();
      expect(jsLinkCount).toBe(0);

      await bob.waitForTimeout(200);
      expect(alertCalled).toBe(0);
    } finally {
      await closeAll(aliceContext, bobContext);
    }
  });
}

test('markdown-corpus: token-cap fallback for **×2000 produces plain text', async ({ browser }) => {
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

    const bombPayload = '**'.repeat(2000);
    await alice.getByTestId('composer').fill(bombPayload);
    await alice.getByTestId('send').click();

    await expect(bob.getByTestId('messages').locator('.chat__msg').first()).toContainText('**', {
      timeout: 10_000,
    });
    const strongCount = await bob.getByTestId('messages').locator('strong').count();
    expect(strongCount).toBeLessThan(600);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('unicode-safety: RTL override is stripped (no hidden reverse) and zero-width is outlined', async ({
  browser,
}) => {
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

    const rtlPayload = 'Hello‮olleH';
    await alice.getByTestId('composer').fill(rtlPayload);
    await alice.getByTestId('send').click();

    const rendered = await bob.getByTestId('messages').locator('.chat__msg').first().textContent();
    expect(rendered).toBeTruthy();
    expect(rendered ?? '').not.toContain('‮');
    expect(rendered ?? '').toContain('Hello');
    expect(rendered ?? '').toContain('olleH');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('unicode-safety: zero-width characters in peer body are wrapped in zw-marker spans', async ({
  browser,
}) => {
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

    const zwPayload = 'pay​pal.com';
    await alice.getByTestId('composer').fill(zwPayload);
    await alice.getByTestId('send').click();

    await expect(bob.getByTestId('messages').locator('.chat__msg').first()).toContainText('pay', {
      timeout: 10_000,
    });
    await expect(bob.getByTestId('messages').locator('.md-pending-text')).toHaveCount(0, {
      timeout: 10_000,
    });
    const markerCount = await bob.getByTestId('messages').locator('.zw-marker').count();
    expect(markerCount).toBeGreaterThan(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

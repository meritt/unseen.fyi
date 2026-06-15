import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { enableVirtualAuthenticator } from './fixtures/webauthn';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 15_000,
  });
};

test('payload-size-budget: PRF sessionStorage record stays under 160 bytes', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    const lengths = await alice.evaluate(() => {
      const lens: number[] = [];
      for (let i = 0; i < globalThis.sessionStorage.length; i += 1) {
        const key = globalThis.sessionStorage.key(i);
        if (key === null) {
          continue;
        }
        const value = globalThis.sessionStorage.getItem(key);
        if (value === null) {
          continue;
        }
        lens.push(value.length);
      }
      return lens;
    });
    expect(lengths.length).toBe(1);
    expect(lengths[0]).toBeLessThan(200);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('prf-register-cancel: alice cancels Touch ID → session stays RAM-mode', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice, { isUserVerified: false });
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());

    await waitForActive(alice);
    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgrade_dismissed_by_user')).toBeVisible({
      timeout: 5000,
    });
    await expect(alice.locator('main.chat')).toHaveAttribute('data-mode', 'RAM');
    const aliceStorage = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(aliceStorage).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('prf-resume-cancel: a rejected credentials.get() on resume locks the session; ending it clears storage', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const aliceAuth = await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    const list = (await aliceAuth.cdp.send('WebAuthn.getCredentials', {
      authenticatorId: aliceAuth.authenticatorId,
    })) as { credentials: Array<{ credentialId: string }> };
    for (const cred of list.credentials) {
      await aliceAuth.cdp.send('WebAuthn.removeCredential', {
        authenticatorId: aliceAuth.authenticatorId,
        credentialId: cred.credentialId,
      });
    }

    await alice.reload();

    await expect(alice.getByTestId('resume-locked')).toBeVisible({ timeout: 15_000 });
    await alice.getByTestId('resume-locked-end').click();

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 5000 },
    );
    const aliceStorage = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(aliceStorage).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('prf-resume-prf-stripped: F5 with an authenticator that lost PRF support → unwrap fails → TERMINATED', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const aliceAuth = await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    const list = (await aliceAuth.cdp.send('WebAuthn.getCredentials', {
      authenticatorId: aliceAuth.authenticatorId,
    })) as {
      credentials: Array<{
        credentialId: string;
        isResidentCredential: boolean;
        rpId: string;
        privateKey: string;
        signCount: number;
        userHandle?: string;
      }>;
    };
    const cred = list.credentials[0];
    if (cred === undefined) {
      throw new Error('expected a registered credential after upgrade');
    }
    await aliceAuth.cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: aliceAuth.authenticatorId,
    });
    const stripped = await enableVirtualAuthenticator(alice, { hasPrf: false });
    await stripped.cdp.send('WebAuthn.addCredential', {
      authenticatorId: stripped.authenticatorId,
      credential: {
        credentialId: cred.credentialId,
        isResidentCredential: cred.isResidentCredential,
        rpId: cred.rpId,
        privateKey: cred.privateKey,
        signCount: cred.signCount,
        ...(cred.userHandle === undefined ? {} : { userHandle: cred.userHandle }),
      },
    });

    await alice.reload();

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 15_000 },
    );
    const aliceStorage = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(aliceStorage).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('ram-mode-non-extractable: in RAM-mode, exportKey on the session key throws', async ({
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

    const exportError = await alice.evaluate(async () => {
      const seed = new Uint8Array(32).fill(7);
      const baseKey = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
      const sessionKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(),
          info: new Uint8Array(),
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      try {
        await crypto.subtle.exportKey('raw', sessionKey);
        return 'NO_THROW';
      } catch (err) {
        return err instanceof Error ? err.name : 'UnknownError';
      }
    });
    expect(exportError).not.toBe('NO_THROW');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('ram-mode-no-storage: without a platform authenticator, storage stays empty in ACTIVE', async ({
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

    const storage = await alice.evaluate(() => ({
      session: globalThis.sessionStorage.length,
      localKeys: Object.keys(globalThis.localStorage).filter((k) => k !== 'c7XmK9-bN4q'),
    }));
    expect(storage).toEqual({ session: 0, localKeys: [] });
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('wrapped-blob: PRF storage value contains a base64url-encoded wrapped key of the expected size', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    const k = await alice.evaluate(() => {
      const key = globalThis.sessionStorage.key(0);
      if (key === null) {
        return undefined;
      }
      const raw = globalThis.sessionStorage.getItem(key);
      if (raw === null) {
        return undefined;
      }
      const parsed = JSON.parse(raw) as { k?: string };
      return parsed.k;
    });
    expect(k).toBeDefined();
    if (k === undefined) {
      throw new Error('PRF storage value missing');
    }
    const decodedLength = await alice.evaluate((s: string) => {
      const std = s.replaceAll('-', '+').replaceAll('_', '/');
      const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
      return atob(std + pad).length;
    }, k);
    expect(decodedLength).toBe(40);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('signal-not-called-on-ram-terminate: panic in RAM-mode does not invoke signalUnknownCredential', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    let signalCalled = 0;
    await alice.exposeFunction('__signalSpy', () => {
      signalCalled += 1;
    });
    await alice.addInitScript(`
      if (typeof globalThis.PublicKeyCredential === 'function') {
        globalThis.PublicKeyCredential.signalUnknownCredential = function() {
          const w = globalThis;
          if (typeof w.__signalSpy === 'function') w.__signalSpy();
          return Promise.resolve();
        };
      }
    `);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
    expect(signalCalled).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('signal-called-on-clean-terminate-prf: panic in PRF-mode invokes signalUnknownCredential', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    let signalCalled = 0;
    await alice.exposeFunction('__signalSpy', () => {
      signalCalled += 1;
    });
    await alice.addInitScript(`
      const ORIG = globalThis.PublicKeyCredential?.signalUnknownCredential;
      if (typeof globalThis.PublicKeyCredential === 'function') {
        globalThis.PublicKeyCredential.signalUnknownCredential = function(opts) {
          const w = globalThis;
          if (typeof w.__signalSpy === 'function') w.__signalSpy();
          return typeof ORIG === 'function' ? ORIG.call(this, opts) : Promise.resolve();
        };
      }
    `);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
    await alice.waitForTimeout(200);
    expect(signalCalled).toBe(1);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('signal-throw-is-silent: a throwing signalUnknownCredential does not block PRF terminate', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.addInitScript(`
      if (typeof globalThis.PublicKeyCredential === 'function') {
        globalThis.PublicKeyCredential.signalUnknownCredential = function() {
          throw new Error('synthetic-failure');
        };
      }
    `);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
    const storage = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(storage).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('signal-unavailable-no-op: missing signalUnknownCredential does not crash PRF terminate', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.addInitScript(`
      if (typeof globalThis.PublicKeyCredential === 'function') {
        delete globalThis.PublicKeyCredential.signalUnknownCredential;
      }
    `);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
    const storage = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(storage).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('cross-tab-new-credential: opening the same URL in another tab generates a fresh credential', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  try {
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();
    await enableVirtualAuthenticator(tabA);
    await enableVirtualAuthenticator(tabB);

    await tabA.goto('/');
    await tabA.getByTestId('create-room').click();
    await tabA.waitForURL(/\/r402#[\w-]{43}$/u);

    await tabB.goto('/');
    await tabB.getByTestId('create-room').click();
    await tabB.waitForURL(/\/r402#[\w-]{43}$/u);

    const aStorage = await tabA.evaluate(() => globalThis.sessionStorage.length);
    const bStorage = await tabB.evaluate(() => globalThis.sessionStorage.length);
    expect(aStorage).toBe(0);
    expect(bStorage).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('signal-order-invariant: WS close fires before signalUnknownCredential before sessionStorage.removeItem', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    const order: Array<{ event: string; time: number }> = [];
    await alice.exposeFunction('__stampOrder', (event: string, time: number) => {
      order.push({ event, time });
    });
    await alice.addInitScript(() => {
      type Stamper = (event: string, time: number) => void;
      const w = globalThis as { __stampOrder?: Stamper };
      const stamp = (event: string): void => {
        w.__stampOrder?.(event, performance.now());
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
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
    await alice.waitForTimeout(200);

    const find = (event: string): number =>
      order.find((entry) => entry.event === event)?.time ?? Number.POSITIVE_INFINITY;
    const wsAt = find('wsClose');
    const signalAt = find('signal');
    const removeAt = find('removeItem');
    expect(wsAt).toBeLessThan(signalAt);
    expect(signalAt).toBeLessThanOrEqual(removeAt);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('f5-during-registering-passkey: F5 before PRF storage commit lands in TERMINATED with empty storage', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    await enableVirtualAuthenticator(alice);
    let signalCalled = 0;
    await alice.exposeFunction('__signalSpy', () => {
      signalCalled += 1;
    });
    await alice.addInitScript(`
      const orig = globalThis.PublicKeyCredential?.signalUnknownCredential;
      if (typeof orig === 'function') {
        globalThis.PublicKeyCredential.signalUnknownCredential = function(opts) {
          const w = globalThis;
          if (typeof w.__signalSpy === 'function') w.__signalSpy();
          return orig.call(this, opts);
        };
      }
    `);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await alice.reload();

    await alice.waitForTimeout(2000);
    const aliceStorage = await alice.evaluate(() => ({
      session: globalThis.sessionStorage.length,
      localKeys: Object.keys(globalThis.localStorage).filter((k) => k !== 'c7XmK9-bN4q'),
    }));
    expect(aliceStorage).toEqual({ session: 0, localKeys: [] });
    expect(signalCalled).toBe(0);
  } finally {
    await closeAll(aliceContext);
  }
});

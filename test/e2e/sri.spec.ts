import { expect, test } from '@playwright/test';

import { useProdDist } from './fixtures/prod-dist.ts';

test.describe.configure({ mode: 'serial' });

const prodDist = useProdDist('SRI suite runs once on Chromium');

test('asset inventory: integrity + crossorigin on every script and stylesheet', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'SRI suite runs once on Chromium');
  await page.goto(prodDist().baseUrl);
  await page.waitForLoadState('domcontentloaded');

  const inventory = await page.evaluate(() => {
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')];
    const inlineStyles = document.querySelectorAll('style').length;
    const scripts = [...document.querySelectorAll('script')];
    const preloads = [...document.querySelectorAll('link[rel="modulepreload"]')];
    return {
      stylesheetCount: stylesheets.length,
      inlineStyleCount: inlineStyles,
      scriptCount: scripts.length,
      preloadCount: preloads.length,
      everyScriptIntegrity: scripts.every(
        (s) => s.getAttribute('integrity')?.startsWith('sha384-') === true,
      ),
      everyScriptCrossorigin: scripts.every((s) => s.getAttribute('crossorigin') === 'anonymous'),
      everyStylesheetIntegrity: stylesheets.every(
        (l) => l.getAttribute('integrity')?.startsWith('sha384-') === true,
      ),
      everyPreloadIntegrity: preloads.every(
        (l) => l.getAttribute('integrity')?.startsWith('sha384-') === true,
      ),
      hasInlineScript: scripts.some((s) => s.src === '' && s.textContent !== ''),
    };
  });

  expect(inventory.stylesheetCount).toBe(1);
  expect(inventory.inlineStyleCount).toBe(0);
  expect(inventory.hasInlineScript).toBe(false);
  expect(inventory.scriptCount).toBeGreaterThanOrEqual(1);
  expect(inventory.everyScriptIntegrity).toBe(true);
  expect(inventory.everyScriptCrossorigin).toBe(true);
  expect(inventory.everyStylesheetIntegrity).toBe(true);
  expect(inventory.everyPreloadIntegrity).toBe(true);
});

test('sri-mismatch: mutated main bundle is blocked by the browser', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'SRI suite runs once on Chromium');
  await page.route(/\/assets\/main-[\w]+\.js$/u, async (route) => {
    const original = await route.fetch();
    const body = await original.text();
    const mutated = `${body}/*tamper*/`;
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: mutated,
    });
  });

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(prodDist().baseUrl, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  const bodyState = await page.evaluate(() => ({
    firstTag: document.body.firstElementChild?.tagName.toLowerCase() ?? '',
    landingViewCount: document.querySelectorAll('landing-view').length,
    chatViewCount: document.querySelectorAll('chat-view').length,
  }));
  expect(bodyState.firstTag).toBe('main');
  expect(bodyState.landingViewCount).toBe(0);
  expect(bodyState.chatViewCount).toBe(0);

  const integrityErrors = consoleErrors.filter(
    (msg) =>
      msg.toLowerCase().includes('integrity') ||
      msg.toLowerCase().includes('sri') ||
      msg.toLowerCase().includes('failed to find a valid digest'),
  );
  expect(integrityErrors.length).toBeGreaterThan(0);
});

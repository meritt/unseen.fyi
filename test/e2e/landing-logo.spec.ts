import { expect, type Locator, test } from '@playwright/test';

const FIRST_PATH_SELECTOR = '[data-testid="landing-logo"] svg path';
const LOGO_SELECTOR = '[data-testid="landing-logo"]';
const CREATE_SELECTOR = '[data-testid="create-room"]';

const readOpacity = async (locator: Locator): Promise<number> =>
  await locator.evaluate((el) => Number.parseFloat(globalThis.getComputedStyle(el).opacity));

test('logo dissolves when create button is hovered and restores on mouse-leave', async ({
  page,
}) => {
  await page.goto('/');
  const logo = page.locator(LOGO_SELECTOR);
  await expect(logo).toBeVisible();
  const firstPath = page.locator(FIRST_PATH_SELECTOR).first();
  const createButton = page.locator(CREATE_SELECTOR);

  expect(await readOpacity(firstPath)).toBeGreaterThan(0.95);

  await createButton.hover();
  await page.waitForTimeout(2300);
  expect(await readOpacity(firstPath)).toBeLessThan(0.1);

  await page.mouse.move(0, 0);
  await page.waitForTimeout(5500);
  expect(await readOpacity(firstPath)).toBeGreaterThan(0.95);
});

test('prefers-reduced-motion disables the dissolve effect', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const logo = page.locator(LOGO_SELECTOR);
    await expect(logo).toBeVisible();
    const firstPath = page.locator(FIRST_PATH_SELECTOR).first();
    await page.locator(CREATE_SELECTOR).hover();
    await page.waitForTimeout(700);
    expect(await readOpacity(firstPath)).toBeGreaterThan(0.95);
  } finally {
    await context.close();
  }
});

test('keyboard focus on the create button triggers the dissolve effect', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator(LOGO_SELECTOR);
  await expect(logo).toBeVisible();
  await page.locator(CREATE_SELECTOR).focus();
  const firstPath = page.locator(FIRST_PATH_SELECTOR).first();
  await page.waitForTimeout(2300);
  expect(await readOpacity(firstPath)).toBeLessThan(0.1);
});

test('touch device with no hover capability does not trigger the dissolve', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'isMobile context option is Chromium-only');
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const logo = page.locator(LOGO_SELECTOR);
    await expect(logo).toBeVisible();
    await logo.tap();
    await page.waitForTimeout(700);
    const firstPath = page.locator(FIRST_PATH_SELECTOR).first();
    expect(await readOpacity(firstPath)).toBeGreaterThan(0.95);
  } finally {
    await context.close();
  }
});

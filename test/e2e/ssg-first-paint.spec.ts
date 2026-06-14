import { expect, test } from '@playwright/test';

test('/ delivers prerendered landing copy in the initial HTML response', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<main class="landing">');
  expect(html).toContain('<h1 class="landing__logo"');
  expect(html).not.toContain('<landing-view');
  expect(html).not.toContain('<app-root');
  expect(html).toContain('Private one-on-one chat that disappears.');
  expect(html).toContain('Create a private room');
  expect(html).toContain('End-to-end encrypted');
  expect(html).toContain('One-time private session');
  expect(html).toContain('No sign-ups. No data stored.');
});

test('/r402 delivers prerendered chat skeleton with Connecting… placeholder', async ({
  request,
}) => {
  const res = await request.get('/r402');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<main class="chat"');
  expect(html).toContain('<header class="chat-header">');
  expect(html).not.toContain('<chat-view');
  expect(html).not.toContain('<chat-header>');
  expect(html).not.toContain('<app-root');
  expect(html).toContain('Connecting…');
  expect(html).toContain('data-testid="composer"');
  expect(html).toContain('data-testid="send"');
  expect(html).toContain('disabled>');
  expect(html).toContain('data-state="CONNECTING"');
});

test('/ and /r402 are distinct templates (no shared single-page fallback)', async ({ request }) => {
  const [landing, chat] = await Promise.all([request.get('/'), request.get('/r402')]);
  const landingHtml = await landing.text();
  const chatHtml = await chat.text();
  expect(landingHtml).not.toBe(chatHtml);
  expect(landingHtml).toContain('<main class="landing">');
  expect(landingHtml).not.toContain('<main class="chat"');
  expect(chatHtml).toContain('<main class="chat"');
  expect(chatHtml).not.toContain('<main class="landing">');
});

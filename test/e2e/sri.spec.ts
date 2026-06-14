import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const THIS_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(THIS_DIR, '../..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');

let tempDist = '';
let prodServer: Server | undefined;
let baseUrl = '';

const runProdBuild = (outDir: string): void => {
  const buildResult = spawnSync('bun', ['run', 'build.ts'], {
    cwd: CLIENT_DIR,
    env: { ...process.env, NODE_ENV: 'production', UNSEEN_DIST_DIR: outDir },
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) {
    throw new Error(`prod build failed with code ${String(buildResult.status)}`);
  }
};

const sendFile = (res: ServerResponse, filePath: string): void => {
  const ext = path.extname(filePath);
  const map: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };
  const contentType = map[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  res.end(readFileSync(filePath));
};

const serveDist = (distDir: string): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const SPA_ROUTES: Readonly<Record<string, string>> = {
        '/': '/index.html',
        '/r402': '/r402.html',
      };
      const pathname = SPA_ROUTES[url.pathname] ?? url.pathname;
      const target = path.join(distDir, pathname);
      if (!target.startsWith(distDir)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      try {
        statSync(target);
        sendFile(res, target);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'SRI suite runs once on Chromium');
  tempDist = mkdtempSync(path.join(tmpdir(), 'unseen-prod-dist-'));
  runProdBuild(tempDist);
  prodServer = await serveDist(tempDist);
  const address = prodServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unable to determine server port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

test.afterAll(async () => {
  if (prodServer !== undefined) {
    await new Promise<void>((resolve) => {
      prodServer?.close(() => resolve());
    });
    prodServer = undefined;
  }
  if (tempDist !== '') {
    rmSync(tempDist, { recursive: true, force: true });
    tempDist = '';
  }
});

test('asset inventory: integrity + crossorigin on every script and stylesheet', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'SRI suite runs once on Chromium');
  await page.goto(baseUrl);
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

  await page.goto(baseUrl, { waitUntil: 'load' });
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

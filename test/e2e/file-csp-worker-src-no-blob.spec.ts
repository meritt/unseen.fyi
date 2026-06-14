import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { cacheControlFor, SECURITY_HEADERS } from '../../server/src/static/headers.ts';

const THIS_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(THIS_DIR, '../..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');

let tempDist = '';
let server: Server | undefined;
let baseUrl = '';

const runProdBuild = (outDir: string): void => {
  const result = spawnSync('bun', ['run', 'build.ts'], {
    cwd: CLIENT_DIR,
    env: { ...process.env, NODE_ENV: 'production', UNSEEN_DIST_DIR: outDir },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`prod build failed with code ${String(result.status)}`);
  }
};

const sendFile = (
  res: ServerResponse,
  filePath: string,
  extraHeaders: Record<string, string>,
): void => {
  const ext = path.extname(filePath);
  const map: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  const contentType = map[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, ...extraHeaders });
  res.end(readFileSync(filePath));
};

const serveDist = (distDir: string): Promise<Server> =>
  new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const SPA_ROUTES: Readonly<Record<string, string>> = {
        '/': '/index.html',
        '/r402': '/r402.html',
      };
      const isShell = SPA_ROUTES[url.pathname] !== undefined;
      const pathname = SPA_ROUTES[url.pathname] ?? url.pathname;
      const target = path.join(distDir, pathname);
      if (!target.startsWith(distDir)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      try {
        statSync(target);
        sendFile(res, target, { ...SECURITY_HEADERS, 'Cache-Control': cacheControlFor(!isShell) });
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'CSP spec runs once on Chromium');
  tempDist = mkdtempSync(path.join(tmpdir(), 'unseen-csp-dist-'));
  runProdBuild(tempDist);
  server = await serveDist(tempDist);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unable to determine server port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

test.afterAll(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  }
  if (tempDist !== '') {
    rmSync(tempDist, { recursive: true, force: true });
    tempDist = '';
  }
});

test('CSP locks worker-src to self with no blob: / data: / wildcard escapes', async ({
  browserName,
  request,
}) => {
  test.skip(browserName !== 'chromium', 'CSP spec runs once on Chromium');
  const response = await request.get(`${baseUrl}/`);
  expect(response.status()).toBe(200);
  const csp = response.headers()['content-security-policy'];
  expect(csp).toBeDefined();
  if (csp === undefined) {
    throw new Error('CSP header missing');
  }

  expect(csp).toContain("worker-src 'self'");
  expect(csp).not.toMatch(/worker-src[^;]*blob:/u);
  expect(csp).not.toMatch(/worker-src[^;]*data:/u);
  expect(csp).not.toMatch(/worker-src[^;]*\*/u);

  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain('trusted-types lit-html unseen-worker-url');
});

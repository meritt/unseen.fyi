import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_DIR = path.resolve(import.meta.dir, '..');

const SOURCE_LITERALS: readonly string[] = [
  './markdown-worker.js',
  '../workers/file-probe-worker.js',
  '../workers/file-send-worker.js',
  '../workers/file-receive-worker.js',
];

const WORKER_STEMS: readonly string[] = [
  'markdown-worker',
  'file-probe-worker',
  'file-send-worker',
  'file-receive-worker',
];

let dist = '';
let assetsDir = '';
let bundleSources: readonly string[] = [];

beforeAll(() => {
  dist = mkdtempSync(path.join(tmpdir(), 'unseen-prod-worker-assets-'));
  const result = spawnSync('bun', ['run', 'build.ts'], {
    cwd: CLIENT_DIR,
    env: { ...Bun.env, NODE_ENV: 'production', UNSEEN_DIST_DIR: dist },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`prod build failed with code ${String(result.status)}`);
  }
  assetsDir = path.join(dist, 'assets');
  bundleSources = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(path.join(assetsDir, name), 'utf8'));
});

afterAll(() => {
  if (dist !== '') {
    rmSync(dist, { recursive: true, force: true });
  }
});

const extractWorkerUrlLiterals = (source: string): string[] => {
  const out: string[] = [];
  const re = /new URL\(\s*["'](?<spec>[^"']+worker[^"']*\.js)["']/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = match.groups?.spec;
    if (spec !== undefined) {
      out.push(spec);
    }
  }
  return out;
};

test('every worker URL literal resolves to an emitted asset under /assets/', () => {
  const referenced = new Set<string>();
  for (const source of bundleSources) {
    for (const literal of extractWorkerUrlLiterals(source)) {
      referenced.add(literal);
      const resolved = path.posix.normalize(path.posix.join('/assets/', literal));
      expect(resolved.startsWith('/assets/')).toBe(true);
      const onDisk = path.join(dist, resolved);
      expect(existsSync(onDisk), `${literal} -> ${resolved} must exist on disk`).toBe(true);
    }
  }
  for (const stem of WORKER_STEMS) {
    const hit = [...referenced].some((literal) => path.basename(literal).startsWith(stem));
    expect(hit, `a hashed reference to ${stem} must appear in the bundle`).toBe(true);
  }
}, 60_000);

test('no unrewritten source worker literal survives in the bundle', () => {
  for (const source of bundleSources) {
    for (const literal of SOURCE_LITERALS) {
      expect(
        source.includes(`"${literal}"`) || source.includes(`'${literal}'`),
        `source literal ${literal} must be rewritten to a hashed asset`,
      ).toBe(false);
    }
  }
});

// root statics are copied outside the bundle graph; a dropped copy ships broken links with no build error
test('prod build emits every root static asset (favicon, robots, sitemap, og-image)', () => {
  for (const name of ['favicon.svg', 'robots.txt', 'sitemap.xml', 'og-image.png']) {
    expect(existsSync(path.join(dist, name)), `dist/${name} must be emitted`).toBe(true);
  }
});

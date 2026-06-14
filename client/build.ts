import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { BunPlugin } from 'bun';

import { en } from './src/i18n/en.ts';

const __dirname = import.meta.dirname;
const OUT_DIR = Bun.env.UNSEEN_DIST_DIR ?? path.join(__dirname, 'dist');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const ASSETS_DIR = 'assets';

const isRecord = (value: unknown): value is { readonly [k: string]: unknown } =>
  value !== null && typeof value === 'object';

const resolveDictString = (dotted: string): string => {
  let cursor: unknown = en;
  for (const segment of dotted.split('.')) {
    if (!isRecord(cursor)) {
      throw new Error(`Template path traverses non-object at "${dotted}"`);
    }
    cursor = cursor[segment];
  }
  if (typeof cursor !== 'string') {
    throw new TypeError(`Template path does not resolve to a string at "${dotted}"`);
  }
  return cursor;
};

const htmlEscape = (input: string): string =>
  input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const PLACEHOLDER_RE = /\{\{(?<dotted>[\w.]+)\}\}/gu;

const expandPlaceholders = (source: string): string =>
  source.replaceAll(PLACEHOLDER_RE, (_match, dotted: string) =>
    htmlEscape(resolveDictString(dotted)),
  );

const RAW_TEXT_RE = /<(?<tag>textarea|pre|script|style)\b[^>]*>[\s\S]*?<\/\k<tag>>/giu;

export const minifyHtml = (html: string): string => {
  const bodies: string[] = [];
  const masked = html.replaceAll(RAW_TEXT_RE, (whole: string): string => {
    const openEnd = whole.indexOf('>') + 1;
    const closeStart = whole.lastIndexOf('</');
    bodies.push(whole.slice(openEnd, closeStart));
    return `${whole.slice(0, openEnd)}\uE000${bodies.length - 1}\uE001${whole.slice(closeStart)}`;
  });
  const collapsed = masked.replaceAll(/\s+/gu, ' ').replaceAll(/>\s+</gu, '><').trim();
  return collapsed.replaceAll(
    /\uE000(?<index>\d+)\uE001/gu,
    (_match: string, index: string): string => bodies[Number(index)] ?? '',
  );
};

const TESTID_RE = /\s*data-testid(?:-[a-z0-9-]+)?=(?:"[^"]*"|\$\{[^}]*\})/gu;

const stripTestId = (source: string): string => source.replaceAll(TESTID_RE, '');

const stripTestIdPlugin: BunPlugin = {
  name: 'strip-testid',
  setup(build) {
    build.onLoad({ filter: /client\/src\/components\/.*\.ts$/u }, async (args) => ({
      contents: stripTestId(await Bun.file(args.path).text()),
      loader: 'ts',
    }));
  },
};

const isProd = Bun.env.NODE_ENV === 'production';
const wsUrl = Bun.env.UNSEEN_WS_URL ?? (isProd ? '/ws' : 'ws://localhost:3001/ws');

const resolveReleaseSha = (): string => {
  const fromEnv = Bun.env.UNSEEN_RELEASE_SHA;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
  return git.success ? git.stdout.toString().trim() : '';
};
const releaseSha = resolveReleaseSha();

const cleanOutDir = (): void => {
  if (existsSync(OUT_DIR)) {
    rmSync(OUT_DIR, { recursive: true });
  }
};

const sriFor = async (filePath: string): Promise<string> => {
  const bytes = await Bun.file(filePath).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  const base64 = new Uint8Array(digest).toBase64();
  return `sha384-${base64}`;
};

type Resolved = {
  readonly href: string;
  readonly integrity: string;
};

const resolve = async (absPath: string): Promise<Resolved> => ({
  href: `/${path.relative(OUT_DIR, absPath)}`,
  integrity: await sriFor(absPath),
});

const WORKER_URL_LITERALS: readonly string[] = [
  './markdown-worker.js',
  '../workers/file-probe-worker.js',
  '../workers/file-send-worker.js',
  '../workers/file-receive-worker.js',
];

type BuildOutput = { readonly kind: string; readonly path: string };

const rewriteWorkerUrls = async (outputs: readonly BuildOutput[]): Promise<void> => {
  const workerEntries = outputs.filter(
    (output) =>
      output.kind === 'entry-point' &&
      output.path.endsWith('.js') &&
      /worker/u.test(path.basename(output.path)),
  );
  const rewrites = new Map<string, string>();
  for (const literal of WORKER_URL_LITERALS) {
    const stem = path.basename(literal).replace(/\.js$/u, '');
    const match = workerEntries.find((output) => {
      const base = path.basename(output.path);
      return base === `${stem}.js` || base.startsWith(`${stem}-`);
    });
    if (match === undefined) {
      throw new Error(`rewriteWorkerUrls: no emitted worker asset for ${literal}`);
    }
    rewrites.set(literal, `./${path.basename(match.path)}`);
  }

  const jsOutputs = outputs.filter((output) => output.path.endsWith('.js'));
  for (const output of jsOutputs) {
    const original = await Bun.file(output.path).text();
    let next = original;
    for (const [from, to] of rewrites) {
      next = next.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
    }
    if (next !== original) {
      await Bun.write(output.path, next);
    }
  }

  const specifierRe = /new URL\(\s*["'](?<spec>[^"']+worker[^"']*\.js)["']/gu;
  for (const output of jsOutputs) {
    const text = await Bun.file(output.path).text();
    let match: RegExpExecArray | null;
    while ((match = specifierRe.exec(text)) !== null) {
      const spec = match.groups?.spec;
      if (spec === undefined) {
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join('/assets/', spec));
      if (!resolved.startsWith('/assets/') || !existsSync(path.join(OUT_DIR, resolved))) {
        throw new Error(
          `rewriteWorkerUrls: ${spec} in ${path.relative(OUT_DIR, output.path)} resolves to ` +
            `${resolved}, which is not an emitted asset`,
        );
      }
    }
  }
};

const assertNoTestHookLeak = async (outputs: readonly BuildOutput[]): Promise<void> => {
  const leaked: string[] = [];
  for (const output of outputs) {
    if (!output.path.endsWith('.js')) {
      continue;
    }
    const source = await Bun.file(output.path).text();
    if (source.includes('__unseenTest')) {
      leaked.push(path.relative(OUT_DIR, output.path));
    }
  }
  if (leaked.length > 0) {
    throw new Error(
      `prod bundle contains test-only __unseenTest hook in: ${leaked.join(', ')}. ` +
        'Dead-code elimination of the `if (__UNSEEN_DEV__)` branch failed.',
    );
  }
};

const assertNoTestId = async (outputs: readonly BuildOutput[]): Promise<void> => {
  const leaked: string[] = [];
  for (const output of outputs) {
    if (!output.path.endsWith('.js')) {
      continue;
    }
    const source = await Bun.file(output.path).text();
    if (source.includes('data-testid')) {
      leaked.push(path.relative(OUT_DIR, output.path));
    }
  }
  for (const name of ['index.html', 'r402.html']) {
    const html = await Bun.file(path.join(OUT_DIR, name)).text();
    if (html.includes('data-testid')) {
      leaked.push(name);
    }
  }
  if (leaked.length > 0) {
    throw new Error(`prod build leaks test-only data-testid in: ${leaked.join(', ')}`);
  }
};

const renderStyleTag = (resolved: Resolved): string => {
  if (!isProd) {
    return `<link rel="stylesheet" href="${resolved.href}">`;
  }
  return `<link rel="stylesheet" href="${resolved.href}" integrity="${resolved.integrity}" crossorigin="anonymous">`;
};

const renderScriptTag = (resolved: Resolved): string => {
  if (!isProd) {
    return `<script type="module" src="${resolved.href}"></script>`;
  }
  return `<script type="module" src="${resolved.href}" integrity="${resolved.integrity}" crossorigin="anonymous"></script>`;
};

const renderPreloadTag = (resolved: Resolved): string => {
  if (!isProd) {
    return `<link rel="modulepreload" href="${resolved.href}">`;
  }
  return `<link rel="modulepreload" href="${resolved.href}" integrity="${resolved.integrity}" crossorigin="anonymous">`;
};

// matches static imports only; dynamic import("x") has a paren after import, so those chunks stay lazy
const STATIC_IMPORT_RE = /(?:from|import)\s*["'](?<spec>[^"']+\.js)["']/gu;

// only synchronously-reached chunks get modulepreload; preloading lazy or worker-only chunks defeats the splitting
const collectStaticImportChunks = async (
  entryPath: string,
  chunks: ReadonlyArray<{ readonly path: string }>,
): Promise<Set<string>> => {
  const byBasename = new Map(chunks.map((chunk) => [path.basename(chunk.path), chunk.path]));
  const reached = new Set<string>();
  const visited = new Set<string>([path.basename(entryPath)]);
  const queue: string[] = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const source = await Bun.file(current).text();
    for (const match of source.matchAll(STATIC_IMPORT_RE)) {
      const spec = match.groups?.spec;
      const base = spec === undefined ? undefined : path.basename(spec);
      if (base === undefined || visited.has(base)) {
        continue;
      }
      visited.add(base);
      const chunkPath = byBasename.get(base);
      if (chunkPath !== undefined) {
        reached.add(base);
        queue.push(chunkPath);
      }
    }
  }
  return reached;
};

const renderShell = async (
  templateName: string,
  stylesHtml: string,
  bundleHtml: string,
): Promise<void> => {
  const src = await Bun.file(path.join(TEMPLATES_DIR, templateName)).text();
  const expanded = expandPlaceholders(src)
    .replace('<!--STYLES-->', stylesHtml)
    .replace('<!--BUNDLE-->', bundleHtml);
  const html = isProd ? stripTestId(expanded) : expanded;
  await Bun.write(path.join(OUT_DIR, templateName), minifyHtml(html));
};

const buildOnce = async (): Promise<void> => {
  cleanOutDir();

  const result = await Bun.build({
    entrypoints: [
      path.join(__dirname, 'src/main.ts'),
      path.join(__dirname, 'src/styles/core.css'),
      path.join(__dirname, 'src/domain/markdown-worker.ts'),
      path.join(__dirname, 'src/workers/file-probe-worker.ts'),
      path.join(__dirname, 'src/workers/file-send-worker.ts'),
      path.join(__dirname, 'src/workers/file-receive-worker.ts'),
    ],
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    splitting: isProd,
    minify: isProd,
    sourcemap: isProd ? 'none' : 'linked',
    publicPath: '/assets/',
    naming: {
      entry: isProd ? `${ASSETS_DIR}/[name]-[hash].[ext]` : `${ASSETS_DIR}/[name].[ext]`,
      chunk: isProd ? `${ASSETS_DIR}/[name]-[hash].[ext]` : `${ASSETS_DIR}/[name].[ext]`,
      asset: isProd ? `${ASSETS_DIR}/[name]-[hash].[ext]` : `${ASSETS_DIR}/[name].[ext]`,
    },
    define: {
      __UNSEEN_WS_URL__: JSON.stringify(wsUrl),
      __UNSEEN_DEV__: JSON.stringify(!isProd),
      __UNSEEN_VERSION__: JSON.stringify(releaseSha),
    },
    plugins: isProd ? [stripTestIdPlugin] : [],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error('build failed');
  }

  const jsEntry = result.outputs.find(
    (output) =>
      output.kind === 'entry-point' &&
      output.path.endsWith('.js') &&
      path.basename(output.path).startsWith('main'),
  );
  if (jsEntry === undefined) {
    throw new Error('no main JS entry-point in build output');
  }
  const cssEntry = result.outputs.find(
    (output) => output.kind === 'asset' && output.path.endsWith('.css'),
  );
  if (cssEntry === undefined) {
    throw new Error('no CSS entry-point in build output');
  }
  const chunks = result.outputs.filter(
    (output) => output.kind === 'chunk' && output.path.endsWith('.js'),
  );

  await rewriteWorkerUrls(result.outputs);

  const resolvedJs = await resolve(jsEntry.path);
  const resolvedCss = await resolve(cssEntry.path);
  const staticChunkBasenames = await collectStaticImportChunks(jsEntry.path, chunks);
  const preloadChunks = chunks.filter((c) => staticChunkBasenames.has(path.basename(c.path)));
  const resolvedChunks = await Promise.all(preloadChunks.map(async (c) => await resolve(c.path)));

  const preloadLinks = resolvedChunks.map((c) => renderPreloadTag(c)).join('\n    ');
  const bundleHtml =
    preloadLinks === ''
      ? renderScriptTag(resolvedJs)
      : `${preloadLinks}\n    ${renderScriptTag(resolvedJs)}`;

  const stylesHtml = renderStyleTag(resolvedCss);

  await renderShell('index.html', stylesHtml, bundleHtml);
  await renderShell('r402.html', stylesHtml, bundleHtml);

  for (const fileName of ['favicon.svg', 'robots.txt', 'sitemap.xml', 'og-image.png']) {
    const src = await Bun.file(path.join(__dirname, 'src/assets', fileName)).bytes();
    await Bun.write(path.join(OUT_DIR, fileName), src);
  }

  if (isProd) {
    await assertNoTestHookLeak(result.outputs);
    await assertNoTestId(result.outputs);
  }
};

if (import.meta.main) {
  await buildOnce();
  console.log(`built → ${OUT_DIR} (ws: ${wsUrl}, prod: ${String(isProd)})`);
}

import { watch } from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const OUT_DIR = path.join(__dirname, 'dist');
const SRC_DIR = path.join(__dirname, 'src');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const INDEX_HTML = path.join(OUT_DIR, 'index.html');
const R402_HTML = path.join(OUT_DIR, 'r402.html');
const SPA_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/', INDEX_HTML],
  ['/r402', R402_HTML],
]);
const PORT = Number(Bun.env.UNSEEN_CLIENT_DEV_PORT ?? 5173);

// minimal Trusted Types policy: a stricter CSP would block the cross-port dev WebSocket
const DEV_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "require-trusted-types-for 'script'; trusted-types lit-html unseen-worker-url",
} as const;

const runBuild = async (): Promise<void> => {
  const proc = Bun.spawn(['bun', 'run', 'build.ts'], {
    cwd: __dirname,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`dev: build exited with code ${code}`);
  }
};

await runBuild();

let rebuildScheduled = false;
const scheduleRebuild = (): void => {
  if (rebuildScheduled) {
    return;
  }
  rebuildScheduled = true;
  setTimeout(() => {
    rebuildScheduled = false;
    void runBuild();
  }, 50);
};

watch(SRC_DIR, { recursive: true }, scheduleRebuild);
watch(TEMPLATES_DIR, { recursive: true }, scheduleRebuild);

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url);
    const spaPath = SPA_ROUTES.get(url.pathname);
    if (spaPath !== undefined) {
      const file = Bun.file(spaPath);
      if (await file.exists()) {
        return new Response(file, { headers: DEV_HEADERS });
      }
      return new Response('build pending', { status: 503 });
    }
    const assetPath = path.join(OUT_DIR, url.pathname);
    if (!assetPath.startsWith(`${OUT_DIR}${path.sep}`) && assetPath !== OUT_DIR) {
      return new Response('Not found', { status: 404 });
    }
    const file = Bun.file(assetPath);
    if (await file.exists()) {
      return new Response(file, { headers: DEV_HEADERS });
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`dev server: http://localhost:${String(PORT)}`);

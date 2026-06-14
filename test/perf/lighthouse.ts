import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { launch as launchChrome } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import type * as LH from 'lighthouse/types.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const REPORT_PATH = path.join(REPO_ROOT, 'perf-report.html');
const SERVER_PORT = 4173;
const SERVER_HOST = '127.0.0.1';

const LCP_BUDGET_MS = 1600;
const TBT_BUDGET_MS = 200;
const CLS_BUDGET = 0.05;

const buildClient = async (): Promise<void> => {
  const proc = Bun.spawn(['bun', 'run', '--cwd', 'client', 'build.ts'], {
    cwd: REPO_ROOT,
    env: { ...Bun.env, NODE_ENV: 'production', UNSEEN_WS_URL: '/ws' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`client build failed with code ${String(code)}`);
  }
};

const startServer = async (): Promise<() => Promise<void>> => {
  const proc = Bun.spawn(['bun', 'run', 'server/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...Bun.env,
      UNSEEN_PORT: String(SERVER_PORT),
      UNSEEN_HOST: SERVER_HOST,
      UNSEEN_ALLOWED_ORIGINS: `http://${SERVER_HOST}:${String(SERVER_PORT)}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${SERVER_HOST}:${String(SERVER_PORT)}/healthz`);
      if (res.ok) {
        return async (): Promise<void> => {
          proc.kill();
          await proc.exited;
        };
      }
    } catch {}
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error('server did not respond on /healthz within 5s');
};

const runLighthouse = async (): Promise<void> => {
  const chrome = await launchChrome({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });
  try {
    const flags: LH.Flags = {
      port: chrome.port,
      output: 'html',
      logLevel: 'error',
      onlyCategories: ['performance'],
    };
    const result = await lighthouse(`http://${SERVER_HOST}:${String(SERVER_PORT)}/`, flags);
    if (result === undefined) {
      throw new Error('lighthouse returned no result');
    }
    const report = Array.isArray(result.report) ? result.report[0] : result.report;
    writeFileSync(REPORT_PATH, report ?? '', 'utf8');

    const { lhr } = result;
    const metric = (id: string): number => lhr.audits[id]?.numericValue ?? Number.NaN;
    const lcp = metric('largest-contentful-paint');
    const tbt = metric('total-blocking-time');
    const cls = metric('cumulative-layout-shift');
    const score = lhr.categories.performance?.score ?? 0;

    const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
    const lcpOk = lcp < LCP_BUDGET_MS;
    const tbtOk = tbt < TBT_BUDGET_MS;
    const clsOk = cls < CLS_BUDGET;

    process.stdout.write(`Lighthouse perf score: ${(score * 100).toFixed(0)}\n`);
    process.stdout.write(
      `  LCP: ${fmt(lcp)} ms  ${lcpOk ? 'PASS' : 'FAIL'}  (budget <${String(LCP_BUDGET_MS)})\n`,
    );
    process.stdout.write(
      `  TBT: ${fmt(tbt)} ms  ${tbtOk ? 'PASS' : 'FAIL'}  (budget <${String(TBT_BUDGET_MS)} as INP proxy)\n`,
    );
    process.stdout.write(
      `  CLS: ${fmt(cls)}    ${clsOk ? 'PASS' : 'FAIL'}  (budget <${String(CLS_BUDGET)})\n`,
    );
    process.stdout.write(`Report: ${REPORT_PATH}\n`);

    if (!lcpOk || !tbtOk || !clsOk) {
      process.exit(1);
    }
  } finally {
    chrome.kill();
  }
};

await buildClient();
const stopServer = await startServer();
try {
  await runLighthouse();
} finally {
  await stopServer();
}

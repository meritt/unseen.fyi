import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from '@playwright/test';

const REPO_DIR = path.resolve(import.meta.dirname, '../../..');
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const PORT_ATTEMPTS = 3;

const childEnv = (overrides: Readonly<Record<string, string>>): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('UNSEEN_'),
  );
  return { ...Object.fromEntries(inherited), ...overrides };
};

export type ProdDist = {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
};

const build = (outDir: string): void => {
  const result = spawnSync('bun', ['run', 'build.ts'], {
    cwd: path.join(REPO_DIR, 'client'),
    env: childEnv({ NODE_ENV: 'production', UNSEEN_DIST_DIR: outDir }),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`prod build failed with code ${String(result.status)}`);
  }
};

const freePort = async (): Promise<number> => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  probe.close();
  if (address === null || typeof address === 'string') {
    throw new Error('unable to reserve a port');
  }
  return address.port;
};

const waitUntilServing = async (relay: ChildProcess, baseUrl: string): Promise<boolean> => {
  const deadline = AbortSignal.timeout(READY_TIMEOUT_MS);
  while (!deadline.aborted) {
    if (relay.exitCode !== null || relay.signalCode !== null) {
      return false;
    }
    try {
      const response = await fetch(baseUrl, { signal: deadline });
      if (response.ok) {
        return true;
      }
    } catch {
      /* relay not listening yet */
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  throw new Error('relay did not serve the prod build in time');
};

const stopRelay = async (relay: ChildProcess): Promise<void> => {
  if (relay.exitCode !== null || relay.signalCode !== null) {
    return;
  }
  const exited = once(relay, 'exit');
  relay.kill('SIGTERM');
  const timer = setTimeout(() => relay.kill('SIGKILL'), STOP_TIMEOUT_MS);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
};

export const startProdDist = async (): Promise<ProdDist> => {
  const distDir = mkdtempSync(path.join(tmpdir(), 'unseen-prod-dist-'));
  let relay: ChildProcess | undefined;
  const stop = async (): Promise<void> => {
    if (relay !== undefined) {
      await stopRelay(relay);
    }
    rmSync(distDir, { recursive: true, force: true });
  };
  try {
    build(distDir);
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const port = await freePort();
      relay = spawn('bun', ['run', 'server/src/index.ts'], {
        cwd: REPO_DIR,
        env: childEnv({
          BUN_FEATURE_FLAG_NO_ORPHANS: '1',
          UNSEEN_CLIENT_DIST_DIR: distDir,
          UNSEEN_HOST: '127.0.0.1',
          UNSEEN_PORT: String(port),
        }),
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      if (await waitUntilServing(relay, baseUrl)) {
        return { baseUrl, stop };
      }
      await stopRelay(relay);
      relay = undefined;
    }
    throw new Error(`relay could not bind a free port in ${String(PORT_ATTEMPTS)} attempts`);
  } catch (error) {
    await stop();
    throw error;
  }
};

export const useProdDist = (skipReason: string): (() => ProdDist) => {
  let dist: ProdDist | undefined;
  test.beforeAll(async ({ browserName }) => {
    test.skip(browserName !== 'chromium', skipReason);
    dist = await startProdDist();
  });
  test.afterAll(async () => {
    await dist?.stop();
    dist = undefined;
  });
  return (): ProdDist => {
    if (dist === undefined) {
      throw new Error('prod dist not started');
    }
    return dist;
  };
};

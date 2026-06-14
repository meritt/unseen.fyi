import { base64urlEncode, type Bytes } from '@unseen/shared/crypto/encoding.ts';
import { hkdf } from '@unseen/shared/crypto/hkdf.ts';
import { HKDF_INFO_OPFS_TRANSFERS } from '@unseen/shared/hkdf-infos.ts';

import { Signal } from '../state/signal.ts';
import { createWorker } from '../workers/create-worker.ts';

const ROOM_SECRET_LENGTH = 32;
const OPAQUE_DIR_LENGTH = 8;

const OPAQUE_DIR_RE = /^[A-Za-z0-9_-]{11}$/u;

const PROBE_TIMEOUT_MS = 3000;

export const OPFS_LOCK_NAME = 'X_TbN9q4-pZ';

export const currentOpaqueDir: Signal<string | undefined> = new Signal<string | undefined>(
  undefined,
);

export const deriveOpaqueDirName = async (roomSecret: Bytes): Promise<string> => {
  if (roomSecret.length !== ROOM_SECRET_LENGTH) {
    throw new Error('roomSecret must be 32 bytes');
  }
  const bytes = await hkdf({
    ikm: roomSecret,
    info: HKDF_INFO_OPFS_TRANSFERS,
    length: OPAQUE_DIR_LENGTH,
  });
  return base64urlEncode(bytes);
};

const heldLivenessDirs = new Set<string>();

const holdDirLivenessLock = async (sessionDir: string): Promise<void> => {
  if (heldLivenessDirs.has(sessionDir)) {
    return;
  }
  heldLivenessDirs.add(sessionDir);
  const { promise: acquired, resolve } = Promise.withResolvers<undefined>();
  const markAcquired = resolve.bind(null, undefined);
  void (async (): Promise<void> => {
    try {
      await navigator.locks.request(sessionDir, { mode: 'shared' }, async () => {
        markAcquired();
        await new Promise<never>(() => {});
      });
    } catch {
      markAcquired();
    }
  })();
  await acquired;
};

const queryLiveLockNames = async (): Promise<ReadonlySet<string>> => {
  const { held = [], pending = [] } = await navigator.locks.query();
  const names = new Set<string>();
  for (const { name } of [...held, ...pending]) {
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
};

export const bootSweepOpfs = async (sessionDir: string): Promise<{ readonly enabled: boolean }> => {
  try {
    await holdDirLivenessLock(sessionDir);
    return await navigator.locks.request(
      OPFS_LOCK_NAME,
      { mode: 'exclusive' },
      async (): Promise<{ readonly enabled: boolean }> => {
        const live = await queryLiveLockNames();
        const root = await navigator.storage.getDirectory();
        for await (const entry of root.values()) {
          if (
            entry.kind === 'directory' &&
            OPAQUE_DIR_RE.test(entry.name) &&
            entry.name !== sessionDir &&
            !live.has(entry.name)
          ) {
            await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
          }
        }
        await root.getDirectoryHandle(sessionDir, { create: true });
        return { enabled: true };
      },
    );
  } catch {
    return { enabled: false };
  }
};

export const purgeSessionDir = async (sessionDir: string): Promise<void> => {
  try {
    await navigator.locks.request(
      OPFS_LOCK_NAME,
      { mode: 'exclusive' },
      async (): Promise<void> => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(sessionDir, { recursive: true }).catch(() => {});
      },
    );
  } catch {
    /* best-effort */
  }
};

export const sweepAllOpaqueDirsForBfcache = async (): Promise<void> => {
  try {
    await navigator.locks.request(
      OPFS_LOCK_NAME,
      { mode: 'exclusive' },
      async (): Promise<void> => {
        const live = await queryLiveLockNames();
        const root = await navigator.storage.getDirectory();
        for await (const entry of root.values()) {
          if (
            entry.kind === 'directory' &&
            OPAQUE_DIR_RE.test(entry.name) &&
            !live.has(entry.name)
          ) {
            await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
          }
        }
      },
    );
  } catch {
    /* best-effort */
  }
};

export const runOpfsCapabilityProbe = async (): Promise<boolean> => {
  const globals = globalThis as {
    readonly Worker?: unknown;
    readonly navigator?: { readonly storage?: unknown };
  };
  if (globals.Worker === undefined || globals.navigator?.storage === undefined) {
    return false;
  }
  let worker: Worker;
  try {
    worker = createWorker(new URL('../workers/file-probe-worker.js', import.meta.url), {
      type: 'module',
    });
  } catch {
    return false;
  }
  const probeWorker = worker;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  AbortSignal.timeout(PROBE_TIMEOUT_MS).addEventListener(
    'abort',
    () => {
      resolve(false);
    },
    { once: true },
  );

  probeWorker.addEventListener('message', (event: MessageEvent<{ readonly kind: string }>) => {
    resolve(event.data.kind === 'ok');
  });
  probeWorker.addEventListener('error', () => {
    resolve(false);
  });
  probeWorker.addEventListener('messageerror', () => {
    resolve(false);
  });

  probeWorker.postMessage({ kind: 'probe' });

  try {
    return await promise;
  } finally {
    probeWorker.terminate();
  }
};

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  attachmentMap,
  blobUrlRegistry,
  fileTransferReady,
  fileTransferSupported,
  incomingActive,
  opfsPurgeDone,
  resetFileStateOnTerminate,
  sessionReceivedBytes,
  transferActive,
} from '../src/domain/file-state.ts';
import { currentOpaqueDir, OPFS_LOCK_NAME } from '../src/storage/opfs-transfers.ts';

type RemoveEntryCall = { readonly name: string; readonly options: unknown };
type LockCall = { readonly name: string; readonly mode: unknown };

const installOpfsShim = (): {
  readonly removed: RemoveEntryCall[];
  readonly locks: LockCall[];
  readonly restore: () => void;
} => {
  const removed: RemoveEntryCall[] = [];
  const locks: LockCall[] = [];
  const root = {
    removeEntry: (name: string, options: unknown): Promise<void> => {
      removed.push({ name, options });
      return Promise.resolve();
    },
  };
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  (globalThis as { navigator?: unknown }).navigator = {
    storage: {
      getDirectory: (): Promise<unknown> => Promise.resolve(root),
    },
    locks: {
      request: (
        name: string,
        opts: { readonly mode?: unknown },
        cb: (lock: unknown) => Promise<unknown>,
      ): Promise<unknown> => {
        locks.push({ name, mode: opts.mode });
        return cb(null);
      },
    },
  };
  return {
    removed,
    locks,
    restore: (): void => {
      (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    },
  };
};

beforeEach(() => {
  resetFileStateOnTerminate();
  fileTransferSupported.value = true;
  fileTransferReady.value = false;
});

afterEach(() => {
  resetFileStateOnTerminate();
  fileTransferSupported.value = true;
  fileTransferReady.value = false;
});

describe('file-state initial values', () => {
  test('Signals and collections default to expected initial values', () => {
    expect(fileTransferSupported.value).toBe(true);
    expect(fileTransferReady.value).toBe(false);
    expect(transferActive.value).toBeNull();
    expect(incomingActive.value).toBeNull();
    expect(attachmentMap.size).toBe(0);
    expect(blobUrlRegistry.size).toBe(0);
    expect(sessionReceivedBytes.value).toBe(0);
  });
});

describe('resetFileStateOnTerminate — Signal state', () => {
  test('clears sender/receiver Signals to defaults', () => {
    transferActive.value = {
      tid: '0123456789abcdef',
      phase: 'sending',
      name: 'sample.bin',
      size: 1024,
      sentBytes: 0,
      worker: { terminate: (): void => {} } as unknown as Worker,
      abort: AbortSignal.timeout(60_000),
    };
    incomingActive.value = {
      tid: 'fedcba9876543210',
      phase: 'receiving',
      name: 'incoming.bin',
      size: 2048,
      expectedSize: 2048,
      nextExpectedSeq: 0,
      networkReceivedBytes: 0,
      bytesWritten: 0,
      receiveCredit: 4,
      pendingChunkQueue: [],
      worker: { terminate: (): void => {} } as unknown as Worker,
      abort: AbortSignal.timeout(60_000),
    };
    sessionReceivedBytes.value = 1_000_000;

    resetFileStateOnTerminate();

    expect(transferActive.value).toBeNull();
    expect(incomingActive.value).toBeNull();
    expect(sessionReceivedBytes.value).toBe(0);
  });
});

describe('resetFileStateOnTerminate — collections', () => {
  test('empties attachment map and blob registry', () => {
    const stubHandle = {} as unknown as FileSystemFileHandle;
    attachmentMap.set('tid-1', {
      source: 'opfs',
      handle: stubHandle,
      name: 'a.png',
      size: 1,
    });
    attachmentMap.set('tid-2', {
      source: 'opfs',
      handle: stubHandle,
      name: 'b.jpg',
      size: 2,
    });
    blobUrlRegistry.add('blob:fake-1');
    blobUrlRegistry.add('blob:fake-2');

    resetFileStateOnTerminate();

    expect(attachmentMap.size).toBe(0);
    expect(blobUrlRegistry.size).toBe(0);
  });
});

describe('resetFileStateOnTerminate — capability gates untouched', () => {
  test('does not mutate fileTransferSupported or fileTransferReady', () => {
    fileTransferSupported.value = false;
    fileTransferReady.value = true;

    resetFileStateOnTerminate();

    expect(fileTransferSupported.value).toBe(false);
    expect(fileTransferReady.value).toBe(true);
  });
});

describe('resetFileStateOnTerminate — browser resource teardown', () => {
  test('revokes every registered blob URL', () => {
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
    };

    try {
      blobUrlRegistry.add('blob:fake-1');
      blobUrlRegistry.add('blob:fake-2');

      resetFileStateOnTerminate();

      expect(revoked).toContain('blob:fake-1');
      expect(revoked).toContain('blob:fake-2');
      expect(revoked.length).toBe(2);
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

describe('resetFileStateOnTerminate — OPFS purge', () => {
  test('removes the session opaque dir recursively under the OPFS lock', async () => {
    const shim = installOpfsShim();
    try {
      currentOpaqueDir.value = 'AbCdEfGhIjK';

      void resetFileStateOnTerminate();
      await opfsPurgeDone();

      expect(shim.locks).toEqual([{ name: OPFS_LOCK_NAME, mode: 'exclusive' }]);
      expect(shim.removed).toEqual([{ name: 'AbCdEfGhIjK', options: { recursive: true } }]);
      expect(currentOpaqueDir.value).toBeUndefined();
    } finally {
      shim.restore();
    }
  });

  test('no purge when currentOpaqueDir is undefined', async () => {
    const shim = installOpfsShim();
    try {
      currentOpaqueDir.value = undefined;

      await resetFileStateOnTerminate();

      expect(shim.locks).toEqual([]);
      expect(shim.removed).toEqual([]);
    } finally {
      shim.restore();
    }
  });
});

export type ProbeRequest = { readonly kind: 'probe' };
export type ProbeResponse =
  | { readonly kind: 'ok' }
  | { readonly kind: 'fail'; readonly step: string };

const PROBE_DIR = 'Pq3rT9vXm2K';
const PROBE_FILE = 'tZ8z';
const PROBE_LOCK = 'qH7c2-mZ4xK';

const post = (response: ProbeResponse): void => {
  self.postMessage(response);
};

const probeSahRoundTrip = async (
  probeDir: FileSystemDirectoryHandle,
): Promise<ProbeResponse | undefined> => {
  let sah: FileSystemSyncAccessHandle | undefined;
  try {
    const fileHandle = await probeDir.getFileHandle(PROBE_FILE, { create: true });
    sah = await fileHandle.createSyncAccessHandle();
    const buffer = new Uint8Array([1, 2, 3, 4]);
    const written = sah.write(buffer, { at: 0 });
    if (written !== buffer.byteLength) {
      return { kind: 'fail', step: 'write' };
    }
    sah.truncate(0);
    if (sah.getSize() !== 0) {
      return { kind: 'fail', step: 'getSize' };
    }
  } catch {
    return { kind: 'fail', step: 'sah-roundtrip' };
  } finally {
    sah?.close();
  }
  try {
    await probeDir.removeEntry(PROBE_FILE);
  } catch {
    return { kind: 'fail', step: 'remove-file' };
  }
  return undefined;
};

const probeWebLock = async (): Promise<ProbeResponse | undefined> => {
  try {
    await navigator.locks.request(PROBE_LOCK, { mode: 'exclusive' }, async () => {});
  } catch {
    return { kind: 'fail', step: 'web-locks' };
  }
  return undefined;
};

const probeReadableStream = async (): Promise<ProbeResponse | undefined> => {
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([0xaa]));
        controller.close();
      },
    });
    const reader = stream.getReader();
    const result = await reader.read();
    if (result.done || result.value[0] !== 0xaa) {
      return { kind: 'fail', step: 'readable-stream' };
    }
  } catch {
    return { kind: 'fail', step: 'readable-stream' };
  }
  return undefined;
};

const runProbe = async (): Promise<ProbeResponse> => {
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    return { kind: 'fail', step: 'getDirectory' };
  }
  let probeDir: FileSystemDirectoryHandle;
  try {
    probeDir = await root.getDirectoryHandle(PROBE_DIR, { create: true });
  } catch {
    return { kind: 'fail', step: 'getDirectoryHandle' };
  }
  try {
    const sahResult = await probeSahRoundTrip(probeDir);
    if (sahResult !== undefined) {
      return sahResult;
    }
    const lockResult = await probeWebLock();
    if (lockResult !== undefined) {
      return lockResult;
    }
    const streamResult = await probeReadableStream();
    if (streamResult !== undefined) {
      return streamResult;
    }
    return { kind: 'ok' };
  } finally {
    await root.removeEntry(PROBE_DIR, { recursive: true }).catch(() => {});
  }
};

self.addEventListener('message', (_event: MessageEvent<ProbeRequest>) => {
  void (async (): Promise<void> => {
    post(await runProbe());
  })();
});

self.addEventListener('error', () => {
  post({ kind: 'fail', step: 'worker-error' });
});

self.addEventListener('unhandledrejection', () => {
  post({ kind: 'fail', step: 'unhandled-rejection' });
});

let policy: TrustedTypePolicy | undefined;

const workerUrlPolicy = (): TrustedTypePolicy => {
  policy ??= trustedTypes.createPolicy('unseen-worker-url', {
    createScriptURL: (input: string): string => {
      if (new URL(input).origin !== globalThis.location.origin) {
        throw new Error('cross-origin worker URL rejected');
      }
      return input;
    },
  });
  return policy;
};

export const createWorker = (url: URL, options: WorkerOptions): Worker =>
  new Worker(workerUrlPolicy().createScriptURL(url.href), options);

export type WorkerFactory = () => Worker;

const WORKER_CLOSED_TIMEOUT_MS = 500;
const WORKER_READY_TIMEOUT_MS = 5000;

type WorkerSignal = { readonly kind?: unknown } | null;

export const workerReady = async (worker: Worker): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const ready = resolve.bind(null, true);
  const fail = resolve.bind(null, false);
  const listening = new AbortController();
  const { signal } = listening;
  worker.addEventListener(
    'message',
    (event: MessageEvent<WorkerSignal>) => {
      const kind = event.data?.kind;
      if (kind === 'ready') {
        ready();
      } else if (kind === 'fatal') {
        fail();
      }
    },
    { signal },
  );
  worker.addEventListener('error', fail, { signal });
  worker.addEventListener('messageerror', fail, { signal });
  const timer = globalThis.setTimeout(fail, WORKER_READY_TIMEOUT_MS);
  try {
    return await promise;
  } finally {
    globalThis.clearTimeout(timer);
    listening.abort();
  }
};

export const shutdownWorker = (
  worker: Worker,
  message: { readonly kind: 'abort' | 'finalize' },
): void => {
  worker.postMessage(message);
  globalThis.setTimeout(() => {
    worker.terminate();
  }, WORKER_CLOSED_TIMEOUT_MS);
};

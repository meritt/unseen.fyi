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

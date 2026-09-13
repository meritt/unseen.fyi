import { createWorker, workerReady } from '../workers/create-worker.ts';
import { parseMarkdownString, type MarkdownAst } from './markdown-impl.ts';
import type { WorkerReady, WorkerRequest, WorkerResponse } from './markdown-worker.ts';

const PARSE_TIMEOUT_MS = 200;

type PendingRequest = {
  readonly resolve: (ast: MarkdownAst) => void;
  readonly timeoutHandle: ReturnType<typeof globalThis.setTimeout>;
};

type WorkerState = {
  readonly worker: Worker;
  readonly pending: Map<number, PendingRequest>;
  readonly ready: Promise<boolean>;
};

let nextRequestId = 0;
let state: WorkerState | undefined;

const canUseWorker = (): boolean => 'Worker' in globalThis && 'document' in globalThis;

const handleWorkerResponse = (response: WorkerResponse): void => {
  if (state === undefined) {
    return;
  }
  const pending = state.pending.get(response.id);
  if (pending === undefined) {
    return;
  }
  state.pending.delete(response.id);
  globalThis.clearTimeout(pending.timeoutHandle);
  pending.resolve(response.ast);
};

const spawnWorker = (): WorkerState => {
  const worker = createWorker(new URL('./markdown-worker.js', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', (event: MessageEvent<WorkerReady | WorkerResponse>) => {
    if (!('kind' in event.data)) {
      handleWorkerResponse(event.data);
    }
  });
  return { worker, pending: new Map(), ready: workerReady(worker) };
};

const ensureWorker = (): WorkerState => {
  state ??= spawnWorker();
  return state;
};

export const prewarmMarkdownWorker = (): void => {
  if (canUseWorker()) {
    ensureWorker();
  }
};

const bombFallback = (source: string): MarkdownAst => ({
  nodes: [{ type: 'text', value: source }],
  bombFallback: true,
  source,
});

const terminateAndReset = (): void => {
  if (state === undefined) {
    return;
  }
  const current = state;
  state = undefined;
  current.worker.terminate();
  for (const pending of current.pending.values()) {
    globalThis.clearTimeout(pending.timeoutHandle);
    pending.resolve(bombFallback(''));
  }
};

export const parseMarkdown = async (source: string): Promise<MarkdownAst> => {
  if (!canUseWorker()) {
    return parseMarkdownString(source);
  }
  const current = ensureWorker();
  const ready = await current.ready;
  if (!ready) {
    if (state === current) {
      terminateAndReset();
    }
    return bombFallback(source);
  }
  const id = nextRequestId;
  nextRequestId += 1;
  const deferred = Promise.withResolvers<MarkdownAst>();
  const timeoutHandle = globalThis.setTimeout(() => {
    current.pending.delete(id);
    deferred.resolve(bombFallback(source));
    if (state === current) {
      terminateAndReset();
    }
  }, PARSE_TIMEOUT_MS);
  current.pending.set(id, { resolve: deferred.resolve, timeoutHandle });
  const request: WorkerRequest = { id, source };
  current.worker.postMessage(request);
  return await deferred.promise;
};

export type { MarkdownAst, MarkdownNode } from './markdown-impl.ts';

import { parseMarkdownString } from './markdown-impl.ts';

export type WorkerRequest = {
  readonly id: number;
  readonly source: string;
};

export type WorkerResponse = {
  readonly id: number;
  readonly ast: ReturnType<typeof parseMarkdownString>;
};

export type WorkerReady = {
  readonly kind: 'ready';
};

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, source } = event.data;
  const ast = parseMarkdownString(source);
  const response: WorkerResponse = { id, ast };
  self.postMessage(response);
});

const ready: WorkerReady = { kind: 'ready' };
self.postMessage(ready);

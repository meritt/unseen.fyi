import { afterEach, describe, expect, test } from 'bun:test';

import {
  appendMessage,
  appendSystemMessage,
  type ChatMessage,
  clearMessages,
  MAX_DOM_MESSAGES,
  messages,
  prunedCount,
} from '../src/state/message-log.ts';

const drainScheduler = async (): Promise<void> => {
  await Promise.resolve();
};

const makeChatMessage = (index: number): ChatMessage => ({
  kind: 'chat',
  id: `m-${String(index)}`,
  direction: 'in',
  body: `body-${String(index)}`,
  receivedAtIso: '2026-05-14T00:00:00.000Z',
});

afterEach(() => {
  clearMessages();
});

describe('appendMessage batching', () => {
  test('coalesces synchronous appends into a single signal update', async () => {
    let updates = 0;
    const unsub = messages.subscribe(() => {
      updates += 1;
    });
    appendMessage(makeChatMessage(1));
    appendMessage(makeChatMessage(2));
    appendMessage(makeChatMessage(3));
    expect(messages.value).toEqual([]);
    await drainScheduler();
    expect(updates).toBe(1);
    expect(messages.value.length).toBe(3);
    unsub();
  });

  test('DOM cap enforces 500-message ceiling with pruned counter', async () => {
    const total = MAX_DOM_MESSAGES + 100;
    for (let index = 0; index < total; index += 1) {
      appendMessage(makeChatMessage(index));
    }
    await drainScheduler();
    expect(messages.value.length).toBe(MAX_DOM_MESSAGES);
    expect(prunedCount.value).toBe(100);
    expect(messages.value[0]?.id).toBe('m-100');
    expect(messages.value.at(-1)?.id).toBe(`m-${String(total - 1)}`);
  });

  test('clearMessages resets pruned counter and queue', async () => {
    for (let index = 0; index < MAX_DOM_MESSAGES + 10; index += 1) {
      appendMessage(makeChatMessage(index));
    }
    await drainScheduler();
    expect(prunedCount.value).toBe(10);
    clearMessages();
    expect(messages.value).toEqual([]);
    expect(prunedCount.value).toBe(0);
  });
});

describe('appendSystemMessage', () => {
  test('emits a discriminated system entry preserving event kind', async () => {
    appendSystemMessage('session_started', '2026-05-14T00:00:01.000Z');
    appendSystemMessage('peer_disconnected', '2026-05-14T00:00:02.000Z');
    await drainScheduler();
    expect(messages.value.length).toBe(2);
    const first = messages.value[0];
    const second = messages.value[1];
    expect(first?.kind).toBe('system');
    expect(second?.kind).toBe('system');
    if (first?.kind === 'system') {
      expect(first.event).toBe('session_started');
      expect(first.receivedAtIso).toBe('2026-05-14T00:00:01.000Z');
    }
    if (second?.kind === 'system') {
      expect(second.event).toBe('peer_disconnected');
    }
  });

  test('interleaves with chat messages in chronological order', async () => {
    appendMessage(makeChatMessage(1));
    appendSystemMessage('peer_disconnected', '2026-05-14T00:00:01.000Z');
    appendMessage(makeChatMessage(2));
    appendSystemMessage('peer_reconnected', '2026-05-14T00:00:02.000Z');
    appendMessage(makeChatMessage(3));
    await drainScheduler();
    expect(messages.value.length).toBe(5);
    const kinds = messages.value.map((m) => m.kind);
    expect(kinds).toEqual(['chat', 'system', 'chat', 'system', 'chat']);
  });

  test('counts against the same DOM cap as chat messages', async () => {
    for (let index = 0; index < MAX_DOM_MESSAGES; index += 1) {
      appendMessage(makeChatMessage(index));
    }
    appendSystemMessage('session_ended', '2026-05-14T00:00:00.000Z');
    await drainScheduler();
    expect(messages.value.length).toBe(MAX_DOM_MESSAGES);
    expect(prunedCount.value).toBe(1);
    const last = messages.value.at(-1);
    expect(last?.kind).toBe('system');
  });
});

import { Signal } from './signal.ts';

export type SystemEventKind =
  | 'waiting_for_peer'
  | 'session_started'
  | 'peer_disconnected'
  | 'peer_reconnected'
  | 'session_ended'
  | 'duplicate_tab_blocked'
  | 'mode_downgraded_to_ram'
  | 'mode_upgraded_locally'
  | 'peer_mode_upgraded'
  | 'mode_upgrade_invited'
  | 'mode_upgrade_dismissed_by_user'
  | 'mode_upgrade_failed'
  | 'session_hardened'
  | 'file_transfer_cancelled'
  | 'file_transfer_failed'
  | 'file_peer_unavailable'
  | 'file_session_cap_reached';

export type ChatMessage = {
  readonly kind: 'chat';
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly body: string;
  readonly receivedAtIso: string;
};

export type SystemMessage = {
  readonly kind: 'system';
  readonly id: string;
  readonly event: SystemEventKind;
  readonly receivedAtIso: string;
};

export type FileMessage = {
  readonly kind: 'file_message';
  readonly id: string;
  readonly tid: string;
  readonly direction: 'in' | 'out';
  readonly receivedAtIso: string;
};

export type Message = ChatMessage | SystemMessage | FileMessage;

export const MAX_DOM_MESSAGES = 500;

export const messages = new Signal<readonly Message[]>([]);

export const prunedCount = new Signal<number>(0);

let pending: Message[] = [];
let rafScheduled = false;

function flushPending(): void {
  rafScheduled = false;
  if (pending.length === 0) {
    return;
  }
  const next = [...messages.value, ...pending];
  pending = [];
  if (next.length > MAX_DOM_MESSAGES) {
    const overflow = next.length - MAX_DOM_MESSAGES;
    prunedCount.value += overflow;
    messages.value = next.slice(overflow);
  } else {
    messages.value = next;
  }
}

const scheduleFlush = (): void => {
  if (rafScheduled) {
    return;
  }
  rafScheduled = true;
  globalThis.requestAnimationFrame(flushPending);
};

export const appendMessage = (message: ChatMessage): void => {
  pending.push(message);
  scheduleFlush();
};

export const appendSystemMessage = (event: SystemEventKind, receivedAtIso: string): void => {
  pending.push({
    kind: 'system',
    id: crypto.randomUUID(),
    event,
    receivedAtIso,
  });
  scheduleFlush();
};

export const appendFileMessage = (
  tid: string,
  direction: 'in' | 'out',
  receivedAtIso: string,
): void => {
  pending.push({
    kind: 'file_message',
    id: crypto.randomUUID(),
    tid,
    direction,
    receivedAtIso,
  });
  scheduleFlush();
};

export const clearMessages = (): void => {
  pending = [];
  rafScheduled = false;
  prunedCount.value = 0;
  messages.value = [];
};

export const removeSystemMessage = (event: SystemEventKind): void => {
  pending = pending.filter((m) => !(m.kind === 'system' && m.event === event));
  const filtered = messages.value.filter((m) => !(m.kind === 'system' && m.event === event));
  if (filtered.length !== messages.value.length) {
    messages.value = filtered;
  }
};

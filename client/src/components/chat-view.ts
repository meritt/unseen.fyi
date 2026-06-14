import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import { MAX_BODY_BYTES, MAX_FILE_SIZE_BYTES } from '@unseen/shared/limits.ts';
import { html, LitElement, nothing, svg, type TemplateResult } from 'lit';

import { isPrfCapable } from '../domain/capability.ts';
import { browserClock } from '../domain/clock.ts';
import {
  attachmentChanged,
  attachmentMap,
  type AttachmentRecord,
  fileTransferReady,
  fileTransferSupported,
  incomingActive,
  notifyAttachmentChanged,
  opfsPurgeDone,
  transferActive,
} from '../domain/file-state.ts';
import { prewarmMarkdownWorker } from '../domain/markdown.ts';
import { type RunningSession, startSession } from '../domain/session.ts';
import { sanitizeFilename } from '../domain/unicode-sanitize.ts';
import { formatSize } from '../i18n/format-size.ts';
import { lang, t } from '../i18n/lang.ts';
import { isPageHiding } from '../lifecycle/page-hide.ts';
import { runStateTransition } from '../lifecycle/view-transitions.ts';
import {
  appendSystemMessage,
  type ChatMessage,
  type FileMessage,
  type Message,
  messages,
  prunedCount,
  type SystemMessage,
} from '../state/message-log.ts';
import {
  peerMode,
  reconnectAttemptAtMs,
  type SessionState,
  sessionMode,
  sessionState,
} from '../state/session-state.ts';
import {
  bootSweepOpfs,
  currentOpaqueDir,
  deriveOpaqueDirName,
  runOpfsCapabilityProbe,
} from '../storage/opfs-transfers.ts';
import type { FileBubbleState } from './file-bubble.ts';
import { versionStamp } from './version-stamp.ts';
import './message-content.ts';
import './chat-header.ts';
import './burn-button.ts';
import './language-toggle.ts';
import './sas-badge.ts';
import './file-bubble.ts';

const lockIcon = svg`
  <rect x="4.5" y="9" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <path d="M7 9V6.5a3 3 0 0 1 6 0V9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
`;

const clockIcon = svg`
  <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <path d="M10 6.5V10l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
`;

const copyIcon = svg`
  <rect x="3.5" y="5.5" width="7.5" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <rect x="6" y="3" width="7.5" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>
`;

const checkIcon = svg`
  <path d="M4 8.5l3 3 5.5-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
`;

const paperclipIcon = svg`
  <path d="M14.5 7.5 7.5 14.5a3.5 3.5 0 0 1-4.95-4.95L10 2a2.4 2.4 0 0 1 3.4 3.4L6 12.8a1.3 1.3 0 1 1-1.8-1.8L10.5 4.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
`;

const COPY_CONFIRMED_MS = 1500;

declare const __UNSEEN_WS_URL__: string;

const COMPOSER_ENABLED_STATES: ReadonlySet<string> = new Set(['ACTIVE']);
const AUTO_SCROLL_THRESHOLD_PX = 32;
const TERMINATION_REDIRECT_MS = 10_000;
const PANIC_PURGE_WAIT_MS = 500;

const draftByteLength = (body: string): number => new TextEncoder().encode(body).byteLength;

type AttachButtonState =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'disabled'; readonly tooltip: string }
  | { readonly kind: 'enabled' };

const PLACEHOLDER_KEYS: Partial<Record<SessionState, string>> = {
  CONNECTING: 'chat.placeholder.connecting',
  RESUMING: 'chat.placeholder.resuming',
  HANDSHAKING: 'chat.placeholder.handshaking',
  UPGRADING_LOCAL: 'chat.placeholder.upgradingLocal',
  REKEYING: 'chat.placeholder.rekeying',
  RECONNECTING: 'chat.placeholder.reconnecting',
  FATAL_ENDING: 'chat.placeholder.sessionEnding',
};

const SYSTEM_EVENT_KEYS: Record<SystemMessage['event'], string> = {
  waiting_for_peer: 'chat.system.waitingForPeer',
  session_started: 'chat.system.sessionStarted',
  peer_disconnected: 'chat.system.peerDisconnected',
  peer_reconnected: 'chat.system.peerReconnected',
  session_ended: 'chat.system.sessionEnded',
  duplicate_tab_blocked: 'errors.duplicateTab',
  mode_downgraded_to_ram: 'chat.system.modeDowngradedToRam',
  mode_upgraded_locally: 'chat.system.modeUpgradedLocally',
  peer_mode_upgraded: 'chat.system.peerModeUpgraded',
  mode_upgrade_invited: 'chat.system.modeUpgradeInvited',
  mode_upgrade_dismissed_by_user: 'chat.system.modeUpgradeDismissedByUser',
  mode_upgrade_failed: 'chat.system.modeUpgradeFailed',
  session_hardened: 'chat.system.sessionHardened',
  file_transfer_cancelled: 'chat.fileTransfer.cancelled',
  file_transfer_failed: 'chat.fileTransfer.failed.sender',
  file_peer_unavailable: 'chat.fileTransfer.peerUnavailable',
  file_session_cap_reached: 'chat.fileTransfer.sessionCapReached',
};

export class ChatView extends LitElement {
  static override properties = {
    secret: { attribute: false },
  };

  declare secret: Bytes;

  #session?: RunningSession;
  #sas: Uint8Array<ArrayBuffer> | undefined;
  #prfCapable = false;
  #subs?: AbortController;
  #attachedFile: { file: File; displayName: string } | undefined;
  #reconnectTicker: ReturnType<typeof globalThis.setInterval> | undefined;
  #terminationRedirectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #copyConfirmed = false;
  #copyConfirmedTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  readonly #feedResizeObserver = new ResizeObserver(() => this.#scrollToBottomIfPinned());
  #draft = '';
  #draftTooLong = false;
  #autoScrollAtBottom = true;
  #unreadBelowViewport = 0;
  #lastMessageCount = 0;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    prewarmMarkdownWorker();
    this.#subs = new AbortController();
    const { signal } = this.#subs;
    sessionState.subscribe(() => this.#onStateChange(), { signal });
    messages.subscribe(() => this.#onMessagesChange(), { signal });
    lang.subscribe(() => this.requestUpdate(), { signal });
    prunedCount.subscribe(() => this.requestUpdate(), { signal });
    reconnectAttemptAtMs.subscribe(() => this.#onReconnectChange(), { signal });
    transferActive.subscribe(() => this.requestUpdate(), { signal });
    incomingActive.subscribe(() => this.requestUpdate(), { signal });
    fileTransferSupported.subscribe(() => this.requestUpdate(), { signal });
    fileTransferReady.subscribe(() => this.requestUpdate(), { signal });
    attachmentChanged.subscribe(() => this.requestUpdate(), { signal });
    sessionMode.subscribe(() => this.requestUpdate(), { signal });
    peerMode.subscribe(() => this.requestUpdate(), { signal });
    void this.#bootSession();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#subs?.abort();
    this.#clearReconnectTicker();
    this.#feedResizeObserver.disconnect();
    this.#clearRedirectTimer();
    this.#clearCopyConfirmedTimer();
    if (!isPageHiding()) {
      this.#session?.terminate('view_disconnected');
    }
  }

  readonly #onUpgradeRequested = (): void => {
    if (this.#session === undefined) {
      return;
    }
    void this.#session.upgradeToPrf();
  };

  readonly #onRetryResume = (): void => {
    void this.#session?.retryResume();
  };

  readonly #onEndLockedSession = (): void => {
    this.#session?.terminate('user_ended_resume');
  };

  readonly #onPanicConfirmed = (): void => {
    this.#session?.terminate('user_panic');
    globalThis.sessionStorage.clear();
    void this.#redirectAfterPanicPurge();
  };

  async #redirectAfterPanicPurge(): Promise<void> {
    const deadline = new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, PANIC_PURGE_WAIT_MS);
    });
    await Promise.race([opfsPurgeDone(), deadline]);
    globalThis.location.replace('/');
  }

  #onStateChange(): void {
    if (sessionState.value === 'TERMINATED' && this.#terminationRedirectTimer === undefined) {
      this.#terminationRedirectTimer = globalThis.setTimeout(() => {
        globalThis.sessionStorage.clear();
        globalThis.location.replace('/');
      }, TERMINATION_REDIRECT_MS);
    }
    runStateTransition(() => this.requestUpdate());
  }

  #clearRedirectTimer(): void {
    if (this.#terminationRedirectTimer !== undefined) {
      globalThis.clearTimeout(this.#terminationRedirectTimer);
      this.#terminationRedirectTimer = undefined;
    }
  }

  #clearReconnectTicker(): void {
    if (this.#reconnectTicker !== undefined) {
      globalThis.clearInterval(this.#reconnectTicker);
      this.#reconnectTicker = undefined;
    }
  }

  #onReconnectChange(): void {
    if (reconnectAttemptAtMs.value === undefined) {
      this.#clearReconnectTicker();
    } else {
      this.#reconnectTicker ??= globalThis.setInterval(() => this.requestUpdate(), 250);
    }
    this.requestUpdate();
  }

  #onMessagesChange(): void {
    const next = messages.value.length;
    const added = Math.max(0, next - this.#lastMessageCount);
    this.#lastMessageCount = next;
    if (!this.#autoScrollAtBottom && added > 0) {
      this.#unreadBelowViewport += added;
    }
    this.requestUpdate();
  }

  readonly #onFeedScroll = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight);
    const atBottom = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
    if (atBottom !== this.#autoScrollAtBottom) {
      this.#autoScrollAtBottom = atBottom;
      if (atBottom) {
        this.#unreadBelowViewport = 0;
      }
      this.requestUpdate();
    }
  };

  readonly #onJumpToBottom = (): void => {
    const sentinel = this.querySelector<HTMLElement>('.chat__sentinel');
    sentinel?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    this.#autoScrollAtBottom = true;
    this.#unreadBelowViewport = 0;
    this.requestUpdate();
  };

  override updated(): void {
    this.#scrollToBottomIfPinned();
    this.#feedResizeObserver.disconnect();
    const feed = this.querySelector<HTMLElement>('.chat__feed');
    if (feed === null) {
      return;
    }
    this.#feedResizeObserver.observe(feed);
    for (const item of feed.children) {
      if (item instanceof HTMLElement) {
        this.#feedResizeObserver.observe(item);
      }
    }
  }

  #scrollToBottomIfPinned(): void {
    if (!this.#autoScrollAtBottom) {
      return;
    }
    const sentinel = this.querySelector<HTMLElement>('.chat__sentinel');
    sentinel?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }

  async #bootSession(): Promise<void> {
    const live = (): boolean => this.isConnected;
    this.#prfCapable = await isPrfCapable();
    if (!live()) {
      return;
    }
    const session = await startSession({
      secret: this.secret,
      wsUrl: __UNSEEN_WS_URL__,
      rpId: globalThis.location.hostname,
      onSas: (sasBytes) => {
        this.#sas = sasBytes;
        this.requestUpdate();
      },
    });
    if (!live()) {
      session.terminate('view_disconnected');
      return;
    }
    this.#session = session;
    void this.#initFileTransfer();
  }

  async #initFileTransfer(): Promise<void> {
    let opaqueDir: string;
    try {
      opaqueDir = await deriveOpaqueDirName(this.secret);
    } catch {
      fileTransferSupported.value = false;
      fileTransferReady.value = false;
      return;
    }
    const supported = await runOpfsCapabilityProbe();
    fileTransferSupported.value = supported;
    if (!supported) {
      fileTransferReady.value = false;
      return;
    }
    const { enabled } = await bootSweepOpfs(opaqueDir);
    fileTransferReady.value = enabled;
    if (enabled) {
      currentOpaqueDir.value = opaqueDir;
    }
  }

  readonly #onInput = (event: Event): void => {
    const { currentTarget } = event;
    if (currentTarget instanceof HTMLTextAreaElement) {
      this.#draft = currentTarget.value;
      const tooLong = draftByteLength(this.#draft.trim()) > MAX_BODY_BYTES;
      if (tooLong !== this.#draftTooLong) {
        this.#draftTooLong = tooLong;
        this.requestUpdate();
      }
    }
  };

  readonly #onComposerKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    if (sessionState.value !== 'ACTIVE') {
      return;
    }
    event.preventDefault();
    this.#sendDraft();
  };

  readonly #onSend = (): void => {
    this.#sendDraft();
  };

  #sendDraft(): void {
    if (this.#session === undefined || sessionState.value !== 'ACTIVE') {
      return;
    }
    const body = this.#draft.trim();
    if (draftByteLength(body) > MAX_BODY_BYTES) {
      return;
    }
    const attached = this.#attachedFile;
    const file = attached?.file;
    if (body !== '') {
      void this.#session.send(body);
      this.#draft = '';
      const textarea = this.querySelector<HTMLTextAreaElement>('textarea.composer__field');
      if (textarea !== null) {
        textarea.value = '';
        textarea.focus();
      }
    }
    if (file !== undefined) {
      if (transferActive.value !== null || incomingActive.value !== null) {
        appendSystemMessage('file_transfer_failed', browserClock.nowIso());
        return;
      }
      this.#attachedFile = undefined;
      void this.#session.sendFile(file);
      this.requestUpdate();
    }
  }

  readonly #onCopyLink = async (): Promise<void> => {
    const url = globalThis.location.href;
    try {
      await globalThis.navigator.clipboard.writeText(url);
      this.#flashCopyConfirmed();
    } catch {
      /* clipboard denied */
    }
  };

  #flashCopyConfirmed(): void {
    this.#copyConfirmed = true;
    this.requestUpdate();
    if (this.#copyConfirmedTimer !== undefined) {
      globalThis.clearTimeout(this.#copyConfirmedTimer);
    }
    this.#copyConfirmedTimer = globalThis.setTimeout(() => {
      this.#copyConfirmed = false;
      this.#copyConfirmedTimer = undefined;
      this.requestUpdate();
    }, COPY_CONFIRMED_MS);
  }

  #clearCopyConfirmedTimer(): void {
    if (this.#copyConfirmedTimer !== undefined) {
      globalThis.clearTimeout(this.#copyConfirmedTimer);
      this.#copyConfirmedTimer = undefined;
    }
  }

  readonly #onLinkClick = async (event: Event): Promise<void> => {
    event.preventDefault();
    const url = globalThis.location.href;
    const nav = globalThis.navigator;
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ url });
      } catch {
        /* share dismissed */
      }
      return;
    }
    await this.#onCopyLink();
  };

  #renderFeedItem(message: Message): TemplateResult {
    if (message.kind === 'chat') {
      return this.#renderChatMessage(message);
    }
    if (message.kind === 'file_message') {
      return this.#renderFileMessage(message);
    }
    return this.#renderSystemEntry(message);
  }

  #renderFileMessage(message: FileMessage): TemplateResult {
    const directionClass = message.direction === 'out' ? 'out' : 'in';
    const bubble = this.#buildFileBubbleState(message);
    if (bubble === undefined) {
      return html`
        <li
          class="chat__msg chat__msg--${directionClass} chat__msg--file chat__msg--file-empty"
          data-direction=${directionClass}
          data-testid="file-message"
          data-tid=${message.tid}
          hidden
        ></li>
      `;
    }
    const isUserMessage = bubble.phase === 'attachment' || bubble.phase === 'unavailable';
    if (isUserMessage) {
      return html`
        <li
          class="chat__msg chat__msg--${directionClass} chat__msg--file"
          data-direction=${directionClass}
          data-testid="file-message"
          data-tid=${message.tid}
        >
          <file-bubble
            .state=${bubble}
            @file-bubble-unavailable=${this.#onAttachmentUnavailable}
          ></file-bubble>
        </li>
      `;
    }
    return html`
      <li
        class="chat__system chat__system--file"
        data-direction=${directionClass}
        data-testid="file-message"
        data-tid=${message.tid}
      >
        <file-bubble .state=${bubble}></file-bubble>
      </li>
    `;
  }

  #buildFileBubbleState(message: FileMessage): FileBubbleState | undefined {
    const { tid, direction } = message;
    const attachment = attachmentMap.get(tid);
    if (attachment !== undefined) {
      return this.#buildAttachmentBubbleState(tid, attachment);
    }
    if (direction === 'out') {
      const active = transferActive.value;
      if (active?.tid !== tid) {
        return undefined;
      }
      if (active.phase === 'offered') {
        return {
          phase: 'awaiting-accept',
          tid,
          name: active.name,
          size: active.size,
          onCancel: this.#onCancelTransfer,
        };
      }
      if (active.phase === 'verifying') {
        return { phase: 'verifying', tid, name: active.name, size: active.size };
      }
      return {
        phase: 'inflight',
        tid,
        name: active.name,
        size: active.size,
        direction: 'up',
        progress: active.sentBytes,
        onCancel: this.#onCancelTransfer,
      };
    }
    const incoming = incomingActive.value;
    if (incoming?.tid !== tid) {
      return undefined;
    }
    if (incoming.phase === 'offer-pending') {
      return {
        phase: 'offer',
        tid,
        name: incoming.name,
        size: incoming.size,
        onAccept: this.#onAcceptOffer,
        onDecline: this.#onDeclineOffer,
      };
    }
    return {
      phase: 'inflight',
      tid,
      name: incoming.name,
      size: incoming.size,
      direction: 'down',
      progress: incoming.bytesWritten,
      onCancel: this.#onCancelTransfer,
    };
  }

  #buildAttachmentBubbleState(tid: string, record: AttachmentRecord): FileBubbleState {
    return {
      phase: 'attachment',
      tid,
      name: record.name,
      size: record.size,
      record,
    };
  }

  readonly #onAttachmentUnavailable = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const payload: unknown = event.detail;
    if (payload === null || typeof payload !== 'object') {
      return;
    }
    const tid = 'tid' in payload && typeof payload.tid === 'string' ? payload.tid : undefined;
    if (tid === undefined) {
      return;
    }
    if (attachmentMap.delete(tid)) {
      notifyAttachmentChanged();
    }
  };

  readonly #onAcceptOffer = (): void => {
    void this.#session?.acceptFileOffer();
  };

  readonly #onDeclineOffer = (): void => {
    this.#session?.declineFileOffer();
  };

  #renderChatMessage(message: ChatMessage): TemplateResult {
    return html`
      <li class="chat__msg chat__msg--${message.direction}" data-direction=${message.direction}>
        <message-content .source=${message.body}></message-content>
      </li>
    `;
  }

  #renderModeUpgradeInvited(): TemplateResult {
    const phrase = t('chat.system.modeUpgradeInvited');
    const actionText = t('chat.system.modeUpgradeInvitedAction');
    const parts = phrase.split('[action]');
    const before = parts[0] ?? '';
    const after = parts[1] ?? '';
    return html`
      <li
        class="chat__system"
        role="status"
        data-event="mode_upgrade_invited"
        data-testid="system-mode_upgrade_invited"
      >
        <span
          >${before}<button
            type="button"
            class="chat__system-action-inline"
            data-testid="mode-upgrade-invite-action"
            @click=${this.#onUpgradeRequested}
          >
            ${actionText}</button
          >${after}</span
        >
      </li>
    `;
  }

  #renderWaitingForPeer(): TemplateResult {
    const phrase = t('chat.system.waitingForPeer');
    const linkText = t('chat.system.linkLabel');
    const url = globalThis.location.href;
    const parts = phrase.split('[link]');
    const before = parts[0] ?? '';
    const after = parts[1] ?? '';
    return html`
      <li
        class="chat__system"
        role="status"
        data-event="waiting_for_peer"
        data-testid="system-waiting_for_peer"
      >
        ${before}<span class="chat__invite-tail"
          ><a href=${url} data-testid="invite-link" @click=${this.#onLinkClick}>${linkText}</a
          >${after}<button
            type="button"
            class=${this.#copyConfirmed
              ? 'chat__invite-copy chat__invite-copy--copied'
              : 'chat__invite-copy'}
            data-testid="copy-link"
            aria-label=${t('chat.system.copyLink')}
            data-tooltip=${t('chat.system.copyLink')}
            @click=${this.#onCopyLink}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              ${this.#copyConfirmed ? checkIcon : copyIcon}
            </svg>
          </button></span
        >
      </li>
    `;
  }

  #renderAlertSystemEntry(event: SystemMessage['event'], message: string): TemplateResult {
    return html`
      <li
        class="chat__system chat__system--alert"
        role="alert"
        data-event=${event}
        data-testid="system-${event}"
      >
        ${message}
      </li>
    `;
  }

  #renderSystemEntry(message: SystemMessage): TemplateResult {
    if (message.event === 'waiting_for_peer') {
      return this.#renderWaitingForPeer();
    }
    if (message.event === 'mode_upgrade_invited') {
      return this.#renderModeUpgradeInvited();
    }
    if (message.event === 'session_ended') {
      return this.#renderAlertSystemEntry('session_ended', t('chat.system.sessionEnded'));
    }
    if (message.event === 'duplicate_tab_blocked') {
      return this.#renderAlertSystemEntry('duplicate_tab_blocked', t('errors.duplicateTab'));
    }
    const dataTestId = `system-${message.event}`;
    return html`
      <li class="chat__system" role="status" data-event=${message.event} data-testid=${dataTestId}>
        ${t(SYSTEM_EVENT_KEYS[message.event])}
      </li>
    `;
  }

  #computeAttachState(): AttachButtonState {
    if (sessionState.value !== 'ACTIVE') {
      return { kind: 'hidden' };
    }
    if (!fileTransferSupported.value) {
      return { kind: 'hidden' };
    }
    if (!fileTransferReady.value) {
      return { kind: 'disabled', tooltip: t('chat.fileTransfer.initializing') };
    }
    if (transferActive.value !== null || incomingActive.value !== null) {
      return { kind: 'disabled', tooltip: t('chat.fileTransfer.busyAnotherTransfer') };
    }
    return { kind: 'enabled' };
  }

  #renderAttachButton(state: AttachButtonState): TemplateResult | typeof nothing {
    if (state.kind === 'hidden') {
      return nothing;
    }
    if (state.kind === 'disabled') {
      return html`
        <button
          type="button"
          class="composer__attach"
          data-testid="composer-attach"
          aria-label=${t('chat.fileTransfer.attachAria')}
          aria-description=${state.tooltip}
          data-tooltip=${state.tooltip}
          disabled
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">${paperclipIcon}</svg>
        </button>
      `;
    }
    return html`
      <button
        type="button"
        class="composer__attach"
        data-testid="composer-attach"
        aria-label=${t('chat.fileTransfer.attachAria')}
        data-tooltip=${t('chat.fileTransfer.attachAria')}
        @click=${this.#onAttachClick}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">${paperclipIcon}</svg>
      </button>
    `;
  }

  #renderAttachedFileChip(): TemplateResult | typeof nothing {
    const attached = this.#attachedFile;
    if (attached === undefined) {
      return nothing;
    }
    const { file, displayName } = attached;
    return html`
      <div class="composer__file" data-testid="attached-chip">
        <span class="composer__file-name" data-testid="attached-name">${displayName}</span>
        <span class="composer__file-size">${formatSize(file.size)}</span>
        <button
          type="button"
          class="composer__file-remove"
          data-testid="attached-remove"
          aria-label=${t('chat.fileTransfer.removeAttachment')}
          data-tooltip=${t('chat.fileTransfer.removeAttachment')}
          @click=${this.#onRemoveAttached}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5.5 5.5v6M8 5.5v6M10.5 5.5v6M3 3.5h10M6 3.5V2.5h4V3.5M4.5 3.5l.5 10h6l.5-10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            ></path>
          </svg>
        </button>
      </div>
    `;
  }

  #renderComposer(enabled: boolean): TemplateResult {
    const attachState = this.#computeAttachState();
    return html`
      <div
        class="composer"
        @dragover=${this.#onDragOver}
        @drop=${this.#onDrop}
        @paste=${this.#onPaste}
      >
        ${this.#renderAttachedFileChip()}
        <div class="composer__row">
          ${this.#renderAttachButton(attachState)}
          <textarea
            class="composer__field"
            data-testid="composer"
            name="message"
            rows="1"
            aria-label=${t('chat.composerPlaceholder')}
            placeholder=${t('chat.composerPlaceholder')}
            enterkeyhint="send"
            spellcheck="false"
            autocorrect="off"
            autocapitalize="none"
            autocomplete="off"
            writingsuggestions="false"
            @input=${this.#onInput}
            @keydown=${this.#onComposerKeyDown}
          ></textarea>
          <button
            type="button"
            class="composer__send"
            data-testid="send"
            ?disabled=${!enabled || this.#draftTooLong}
            aria-description=${this.#draftTooLong ? t('chat.composerTooLong') : nothing}
            data-tooltip=${this.#draftTooLong ? t('chat.composerTooLong') : nothing}
            @click=${this.#onSend}
          >
            ${t('chat.sendButton')}
          </button>
        </div>
        <input type="file" data-testid="file-input" hidden @change=${this.#onFilePicked} />
      </div>
    `;
  }

  readonly #onCancelTransfer = (): void => {
    this.#session?.cancelTransfer();
  };

  readonly #onAttachClick = (): void => {
    const input = this.querySelector<HTMLInputElement>('input[type="file"]');
    input?.click();
  };

  readonly #onFilePicked = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const { files } = target;
    const file = files?.[0];
    target.value = '';
    if (file === undefined) {
      return;
    }
    if (file.size === 0 || file.size > MAX_FILE_SIZE_BYTES) {
      appendSystemMessage('file_transfer_failed', browserClock.nowIso());
      return;
    }
    const displayName = sanitizeFilename(file.name);
    if (displayName === null) {
      appendSystemMessage('file_transfer_failed', browserClock.nowIso());
      return;
    }
    this.#attachedFile = { file, displayName };
    this.requestUpdate();
    void this.#focusComposerAfterUpdate();
  };

  readonly #onRemoveAttached = (): void => {
    this.#attachedFile = undefined;
    this.requestUpdate();
    void this.#focusComposerAfterUpdate();
  };

  async #focusComposerAfterUpdate(): Promise<void> {
    await this.updateComplete;
    const textarea = this.querySelector<HTMLTextAreaElement>('textarea.composer__field');
    textarea?.focus();
  }

  readonly #onDragOver = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes('Files') === true) {
      event.preventDefault();
    }
  };

  readonly #onDrop = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes('Files') === true) {
      event.preventDefault();
    }
  };

  readonly #onPaste = (event: ClipboardEvent): void => {
    const files = event.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
    }
  };

  #renderFooter(): TemplateResult {
    return html`
      <footer class="chat__footer">
        <div class="chat__footer-row">
          <div class="chat__signals">
            <span class="chat__signal">
              <svg class="chat__signal-icon" viewBox="0 0 20 20" aria-hidden="true">
                ${lockIcon}
              </svg>
              <span>${t('landing.signalEncrypted')}</span>
            </span>
            <span class="chat__signal-sep" aria-hidden="true">|</span>
            <span class="chat__signal">
              <svg class="chat__signal-icon" viewBox="0 0 20 20" aria-hidden="true">
                ${clockIcon}
              </svg>
              <span>${t('landing.signalOneTime')}</span>
            </span>
          </div>
          <language-toggle></language-toggle>
        </div>
        ${versionStamp()}
      </footer>
    `;
  }

  #renderResumeLocked(): TemplateResult {
    return html`
      <div class="chat__resume-locked" role="alert" data-testid="resume-locked">
        <p class="chat__resume-locked-title">${t('chat.resumeLocked.title')}</p>
        <div class="chat__resume-locked-actions">
          <button
            type="button"
            class="chat__resume-locked-action chat__resume-locked-action--primary"
            data-testid="resume-locked-retry"
            @click=${this.#onRetryResume}
          >
            ${t('chat.resumeLocked.retry')}
          </button>
          <button
            type="button"
            class="chat__resume-locked-action chat__resume-locked-action--secondary"
            data-testid="resume-locked-end"
            @click=${this.#onEndLockedSession}
          >
            ${t('chat.resumeLocked.end')}
          </button>
        </div>
      </div>
    `;
  }

  #renderPlaceholder(): TemplateResult | typeof nothing {
    const state = sessionState.value;
    if (state === 'RESUME_LOCKED') {
      return this.#renderResumeLocked();
    }
    const key = PLACEHOLDER_KEYS[state];
    if (key === undefined) {
      return nothing;
    }
    const label =
      state === 'RECONNECTING' && reconnectAttemptAtMs.value !== undefined
        ? t('chat.placeholder.reconnectingIn', {
            seconds: String(
              Math.max(0, Math.ceil((reconnectAttemptAtMs.value - performance.now()) / 1000)),
            ),
          })
        : t(key);
    return html`
      <div
        class="chat__placeholder"
        role="status"
        aria-live="polite"
        data-testid="chat-placeholder"
      >
        ${label}
      </div>
    `;
  }

  override render(): unknown {
    const state = sessionState.value;
    const ending = state === 'TERMINATED' || state === 'FATAL_ENDING';
    const composerVisible = !ending;
    const composerEnabled = COMPOSER_ENABLED_STATES.has(state);
    const burnVisible = !ending;
    const sasPanelVisible = this.#sas !== undefined && !ending;
    const pruned = prunedCount.value;
    const unread = this.#unreadBelowViewport;
    return html`
      <main
        class="chat"
        data-state=${state}
        data-mode=${sessionMode.value}
        @upgrade-requested=${this.#onUpgradeRequested}
      >
        <h1 class="sr-only">Unseen — private chat</h1>
        <chat-header .prfCapable=${this.#prfCapable}></chat-header>
        <div class="chat__card">
          <div class="chat__card-top">
            ${sasPanelVisible
              ? html`<sas-badge class="chat__sas" .sas=${this.#sas}></sas-badge>`
              : html`<span class="chat__sas chat__sas--placeholder"></span>`}
            ${burnVisible
              ? html`<burn-button @burn-confirmed=${this.#onPanicConfirmed}></burn-button>`
              : ''}
          </div>
          <hr class="chat__card-divider" />
          ${this.#renderPlaceholder()}
          <ul
            class="chat__feed"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            data-testid="messages"
            @scroll=${this.#onFeedScroll}
          >
            ${pruned > 0
              ? html`<li class="chat__earlier-removed" data-testid="earlier-removed">
                  ${t('chat.earlierRemoved')}
                </li>`
              : ''}
            ${messages.value.map((message) => this.#renderFeedItem(message))}
            <li class="chat__sentinel" aria-hidden="true" data-testid="feed-sentinel"></li>
          </ul>
          ${unread > 0 && !this.#autoScrollAtBottom
            ? html`<button
                type="button"
                class="chat__new-badge"
                data-testid="auto-scroll-badge"
                @click=${this.#onJumpToBottom}
              >
                ${t('chat.newMessages', { count: unread })}
              </button>`
            : ''}
          ${composerVisible ? this.#renderComposer(composerEnabled) : ''}
        </div>
        ${this.#renderFooter()}
        <span class="sr-only" data-testid="status" data-state=${state}> ${state} </span>
      </main>
    `;
  }
}

customElements.define('chat-view', ChatView);

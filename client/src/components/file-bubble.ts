import { html, LitElement, svg, type TemplateResult } from 'lit';

import { downloadAttachment } from '../domain/file-download.ts';
import type { AttachmentRecord } from '../domain/file-state.ts';
import { formatSize } from '../i18n/format-size.ts';
import { lang, t } from '../i18n/lang.ts';

const checkIcon = svg`
  <path d="M4 8.5l3 3 5.5-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
`;

const crossIcon = svg`
  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
`;

export type FileBubbleState =
  | {
      readonly phase: 'offer';
      readonly tid: string;
      readonly name: string;
      readonly size: number;
      readonly onAccept: () => void;
      readonly onDecline: () => void;
    }
  | {
      readonly phase: 'awaiting-accept';
      readonly tid: string;
      readonly name: string;
      readonly size: number;
      readonly onCancel: () => void;
    }
  | {
      readonly phase: 'inflight';
      readonly tid: string;
      readonly name: string;
      readonly size: number;
      readonly direction: 'up' | 'down';
      readonly progress: number;
      readonly onCancel: () => void;
    }
  | {
      readonly phase: 'verifying';
      readonly tid: string;
      readonly name: string;
      readonly size: number;
    }
  | {
      readonly phase: 'attachment';
      readonly tid: string;
      readonly name: string;
      readonly size: number;
      readonly record: AttachmentRecord;
    }
  | {
      readonly phase: 'unavailable';
      readonly tid: string;
      readonly name: string;
    };

const isEvictionError = (error: unknown): boolean => {
  if (!(error instanceof DOMException)) {
    return false;
  }
  return error.name === 'NotFoundError' || error.name === 'NotReadableError';
};

const percentOf = (progress: number, size: number): number => {
  const safeSize = Math.max(1, size);
  return Math.min(100, Math.max(0, Math.round((progress / safeSize) * 100)));
};

export class FileBubble extends LitElement {
  static override properties = {
    state: { attribute: false },
  };

  declare state: FileBubbleState;

  #subs?: AbortController;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subs = new AbortController();
    const { signal } = this.#subs;
    lang.subscribe(() => this.requestUpdate(), { signal });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#subs?.abort();
  }

  override render(): TemplateResult {
    const { state } = this;
    if (state.phase === 'offer') {
      return this.#renderOffer(state);
    }
    if (state.phase === 'awaiting-accept') {
      return this.#renderAwaitingAccept(state);
    }
    if (state.phase === 'inflight') {
      return this.#renderInflight(state);
    }
    if (state.phase === 'verifying') {
      return this.#renderVerifying(state);
    }
    if (state.phase === 'attachment') {
      return this.#renderAttachment(state);
    }
    return this.#renderUnavailable(state);
  }

  #iconButton(
    testid: string,
    ariaLabel: string,
    glyph: 'check' | 'cross',
    onClick: () => void,
  ): TemplateResult {
    return html`
      <button
        type="button"
        class="file-bubble__icon-button file-bubble__icon-button--${glyph}"
        data-testid=${testid}
        aria-label=${ariaLabel}
        data-tooltip=${ariaLabel}
        @click=${onClick}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          ${glyph === 'check' ? checkIcon : crossIcon}
        </svg>
      </button>
    `;
  }

  #renderOffer(state: Extract<FileBubbleState, { phase: 'offer' }>): TemplateResult {
    return html`
      <div
        class="file-bubble file-bubble--system file-bubble--offer"
        data-testid="file-bubble-offer"
        data-tid=${state.tid}
      >
        <span class="file-bubble__name">${state.name}</span>
        <span class="file-bubble__meta">${formatSize(state.size)}</span>
        ${this.#iconButton('file-accept', t('chat.fileTransfer.accept'), 'check', state.onAccept)}
        ${this.#iconButton(
          'file-decline',
          t('chat.fileTransfer.decline'),
          'cross',
          state.onDecline,
        )}
      </div>
    `;
  }

  #renderAwaitingAccept(
    state: Extract<FileBubbleState, { phase: 'awaiting-accept' }>,
  ): TemplateResult {
    return html`
      <div
        class="file-bubble file-bubble--system file-bubble--awaiting"
        data-testid="file-bubble-awaiting-accept"
        data-tid=${state.tid}
      >
        <span class="file-bubble__name">${state.name}</span>
        <span class="file-bubble__meta">${formatSize(state.size)}</span>
        ${this.#iconButton('file-cancel', t('chat.fileTransfer.cancel'), 'cross', state.onCancel)}
      </div>
    `;
  }

  #renderInflight(state: Extract<FileBubbleState, { phase: 'inflight' }>): TemplateResult {
    const percent = percentOf(state.progress, state.size);
    const arrow = state.direction === 'down' ? '→' : '←';
    return html`
      <div
        class="file-bubble file-bubble--system file-bubble--inflight"
        data-testid="file-bubble-inflight"
        data-tid=${state.tid}
        data-direction=${state.direction}
      >
        <span class="file-bubble__glyph" aria-hidden="true">${arrow}</span>
        <span class="file-bubble__name">${state.name}</span>
        <span class="file-bubble__meta" data-testid="file-progress">
          ${t('chat.fileTransfer.percent', { percent: String(percent) })}
        </span>
        ${this.#iconButton('file-cancel', t('chat.fileTransfer.cancel'), 'cross', state.onCancel)}
      </div>
    `;
  }

  #renderVerifying(state: Extract<FileBubbleState, { phase: 'verifying' }>): TemplateResult {
    return html`
      <div
        class="file-bubble file-bubble--system file-bubble--verifying"
        data-testid="file-bubble-verifying"
        data-tid=${state.tid}
      >
        <span class="file-bubble__glyph" aria-hidden="true">✓✓</span>
        <span class="file-bubble__name">${state.name}</span>
      </div>
    `;
  }

  #renderAttachment(state: Extract<FileBubbleState, { phase: 'attachment' }>): TemplateResult {
    return html`
      <span
        class="file-bubble file-bubble--attachment"
        data-testid="file-bubble-attachment"
        data-tid=${state.tid}
      >
        <button
          type="button"
          class="file-bubble__name-link"
          data-testid="file-download"
          aria-label=${t('chat.fileTransfer.downloadAria', { name: state.name })}
          @click=${this.#onDownloadClicked}
        >
          ${state.name}
        </button>
        <span class="file-bubble__size">${formatSize(state.size)}</span>
      </span>
    `;
  }

  #renderUnavailable(state: Extract<FileBubbleState, { phase: 'unavailable' }>): TemplateResult {
    return html`
      <div
        class="file-bubble file-bubble--system file-bubble--unavailable"
        data-testid="file-bubble-unavailable"
        data-tid=${state.tid}
      >
        ${t('chat.fileTransfer.unavailable')}
      </div>
    `;
  }

  readonly #onDownloadClicked = (): void => {
    if (this.state.phase !== 'attachment') {
      return;
    }
    void this.#runDownload(this.state.record, this.state.name);
  };

  async #runDownload(record: AttachmentRecord, name: string): Promise<void> {
    if (record.source === 'opfs') {
      try {
        await record.handle.getFile();
      } catch (error) {
        if (isEvictionError(error)) {
          this.#emitUnavailable();
          return;
        }
        return;
      }
    }
    try {
      await downloadAttachment(record, name);
    } catch (error) {
      if (isEvictionError(error)) {
        this.#emitUnavailable();
      }
    }
  }

  #emitUnavailable(): void {
    if (this.state.phase !== 'attachment') {
      return;
    }
    const { tid } = this.state;
    this.dispatchEvent(
      new CustomEvent('file-bubble-unavailable', {
        detail: { tid },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

if (customElements.get('file-bubble') === undefined) {
  customElements.define('file-bubble', FileBubble);
}

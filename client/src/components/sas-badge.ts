import { hexEncode } from '@unseen/shared/crypto/encoding.ts';
import { html, LitElement } from 'lit';

import { lang } from '../i18n/lang.ts';
import { sasEntryForByte } from '../i18n/sas-emoji.ts';

export class SasBadge extends LitElement {
  static override properties = {
    sas: { attribute: false },
  };

  declare sas: Uint8Array<ArrayBuffer> | undefined;

  #announceTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #readback = '';
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
    if (this.#announceTimer !== undefined) {
      globalThis.clearTimeout(this.#announceTimer);
      this.#announceTimer = undefined;
    }
  }

  override updated(): void {
    if (this.sas === undefined) {
      this.#readback = '';
      return;
    }
    if (this.#announceTimer !== undefined) {
      globalThis.clearTimeout(this.#announceTimer);
    }
    const names = [...this.sas].map((byte) => this.#localizedName(byte));
    const readback = new Intl.ListFormat(lang.value, { style: 'long', type: 'unit' }).format(names);
    const STAGE_DELAY_MS = 150;
    this.#announceTimer = globalThis.setTimeout(() => {
      this.#readback = readback;
      this.requestUpdate();
    }, STAGE_DELAY_MS);
  }

  #localizedName(byte: number): string {
    const entry = sasEntryForByte(byte);
    return lang.value === 'ru' ? entry.ru : entry.en;
  }

  override render(): unknown {
    if (this.sas === undefined) {
      return '';
    }
    return html`
      <div class="sas-badge" data-testid="sas-badge" data-testid-sas=${hexEncode(this.sas)}>
        ${[...this.sas].map(
          (byte) => html`
            <figure class="sas-badge__figure">
              <span class="sas-badge__emoji" aria-hidden="true"
                >${sasEntryForByte(byte).emoji}</span
              >
              <figcaption class="sas-badge__caption">${this.#localizedName(byte)}</figcaption>
            </figure>
          `,
        )}
        <span class="sr-only" aria-live="polite" data-testid="sas-readback">${this.#readback}</span>
      </div>
    `;
  }
}

customElements.define('sas-badge', SasBadge);

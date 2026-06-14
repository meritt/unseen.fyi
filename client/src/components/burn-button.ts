import { html, LitElement, svg } from 'lit';

import { lang, t } from '../i18n/lang.ts';

const ARM_TIMEOUT_MS = 3000;

const flameIcon = svg`
  <path
    d="M10 2.5c0 2.5 -3 3.5 -3 6.5 0 2.2 1.3 3.4 3 3.4s3 -1.2 3 -3.4c0 -1.6 -1 -2.4 -1.5 -3.4 1.4 .6 3 2.4 3 4.9 0 3.2 -2.4 5.6 -4.5 5.6s-4.5 -2.4 -4.5 -5.6c0 -3.8 4.5 -4.6 4.5 -8Z"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linejoin="round"
  />
`;

export class BurnButton extends LitElement {
  static override properties = {
    _armed: { state: true },
  };

  declare _armed: boolean;

  #armTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #subs?: AbortController;

  constructor() {
    super();
    this._armed = false;
  }

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
    this.#clearArmTimer();
  }

  #clearArmTimer(): void {
    if (this.#armTimer !== undefined) {
      globalThis.clearTimeout(this.#armTimer);
      this.#armTimer = undefined;
    }
  }

  readonly #onClick = (): void => {
    if (!this._armed) {
      this._armed = true;
      this.#armTimer = globalThis.setTimeout(() => {
        this._armed = false;
      }, ARM_TIMEOUT_MS);
      return;
    }
    this.#clearArmTimer();
    this._armed = false;
    this.dispatchEvent(new CustomEvent('burn-confirmed', { bubbles: true, composed: true }));
  };

  override render(): unknown {
    const classes = this._armed ? 'burn-button burn-button--armed' : 'burn-button';
    const armedLabel = t('panic.confirm');
    const fullLabel = t('header.burn');
    const shortLabel = t('header.burnShort');
    return html`
      <button
        type="button"
        class=${classes}
        data-testid="burn-button"
        aria-label=${this._armed ? armedLabel : fullLabel}
        aria-pressed=${this._armed ? 'true' : 'false'}
        @click=${this.#onClick}
      >
        <svg class="burn-button__icon" viewBox="0 0 20 20" aria-hidden="true">${flameIcon}</svg>
        ${this._armed
          ? html`<span>${armedLabel}</span>`
          : html`<span class="burn-button__label burn-button__label--full">${fullLabel}</span>
              <span class="burn-button__label burn-button__label--short">${shortLabel}</span>`}
      </button>
    `;
  }
}

customElements.define('burn-button', BurnButton);

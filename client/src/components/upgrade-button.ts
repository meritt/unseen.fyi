import { html, LitElement, svg } from 'lit';

import { lang, t } from '../i18n/lang.ts';

const shieldIcon = svg`
  <path
    d="M10 2.5 4.5 4.5v4.6c0 3 2.2 5.7 5.5 7.4 3.3-1.7 5.5-4.4 5.5-7.4V4.5L10 2.5Z"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linejoin="round"
  />
`;

export class UpgradeButton extends LitElement {
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

  readonly #onClick = (): void => {
    this.dispatchEvent(new CustomEvent('upgrade-requested', { bubbles: true, composed: true }));
  };

  override render(): unknown {
    return html`
      <button
        type="button"
        class="upgrade-button"
        data-testid="upgrade-button"
        @click=${this.#onClick}
      >
        <svg class="upgrade-button__icon" viewBox="0 0 20 20" aria-hidden="true">${shieldIcon}</svg>
        <span>${t('chat.upgrade.button')}</span>
      </button>
    `;
  }
}

customElements.define('upgrade-button', UpgradeButton);

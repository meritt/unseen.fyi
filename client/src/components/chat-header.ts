import { html, LitElement, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';

import { UNSEEN_LOGO_VIEW_BOX } from '../assets/unseen-logo-meta.ts';
import { lang, t } from '../i18n/lang.ts';
import { sessionMode, sessionState } from '../state/session-state.ts';
import './mode-status-badge.ts';
import './upgrade-button.ts';

export class ChatHeader extends LitElement {
  static override properties = {
    prfCapable: { type: Boolean },
  };

  declare prfCapable: boolean;

  #subs?: AbortController;
  #logoSvgInner: string | undefined;

  constructor() {
    super();
    this.prfCapable = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subs = new AbortController();
    const { signal } = this.#subs;
    lang.subscribe(() => this.requestUpdate(), { signal });
    sessionState.subscribe(() => this.requestUpdate(), { signal });
    sessionMode.subscribe(() => this.requestUpdate(), { signal });
    void this.#loadLogo();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#subs?.abort();
  }

  async #loadLogo(): Promise<void> {
    const mod = await import('../assets/unseen-svg-source.ts');
    this.#logoSvgInner = mod.extractInnerContent(mod.UNSEEN_SVG_SOURCE);
    this.requestUpdate();
  }

  readonly #onBrandClick = (event: Event): void => {
    event.preventDefault();
    globalThis.location.assign('/');
  };

  override render(): unknown {
    const state = sessionState.value;
    const ending = state === 'FATAL_ENDING' || state === 'TERMINATED';
    const showUpgrade =
      !ending && state === 'ACTIVE' && sessionMode.value === 'RAM' && this.prfCapable;
    const showStatus = !ending && state === 'ACTIVE' && sessionMode.value === 'PRF';
    return html`
      <header class="chat-header">
        <a
          class="chat-header__brand"
          href="/"
          data-testid="brand-home"
          @click=${this.#onBrandClick}
        >
          <svg
            viewBox=${UNSEEN_LOGO_VIEW_BOX}
            class="chat-header__brand-svg"
            role="img"
            aria-label=${t('landing.title')}
          >
            ${this.#logoSvgInner === undefined ? nothing : unsafeSVG(this.#logoSvgInner)}
          </svg>
        </a>
        ${showUpgrade ? html`<upgrade-button></upgrade-button>` : nothing}
        ${showStatus ? html`<mode-status-badge></mode-status-badge>` : nothing}
      </header>
    `;
  }
}

customElements.define('chat-header', ChatHeader);

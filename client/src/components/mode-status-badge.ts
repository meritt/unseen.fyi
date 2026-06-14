import { html, LitElement, svg } from 'lit';

import { lang, t } from '../i18n/lang.ts';
import { peerMode, sessionMode } from '../state/session-state.ts';

const lockOpenIcon = svg`
  <path d="M5.5 9V6a3.5 3.5 0 0 1 7 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <rect x="3.5" y="9" width="11" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
`;

const lockClosedIcon = svg`
  <path d="M6.5 9V6.5a2.5 2.5 0 0 1 5 0V9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <rect x="3.5" y="9" width="11" height="7.5" rx="1.5" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.4"/>
`;

export class ModeStatusBadge extends LitElement {
  #subs?: AbortController;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subs = new AbortController();
    const { signal } = this.#subs;
    lang.subscribe(() => this.requestUpdate(), { signal });
    sessionMode.subscribe(() => this.requestUpdate(), { signal });
    peerMode.subscribe(() => this.requestUpdate(), { signal });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#subs?.abort();
  }

  override render(): unknown {
    const my = sessionMode.value;
    const peer = peerMode.value;
    if (my === 'RAM') {
      return null;
    }
    const hardened = peer === 'PRF';
    const labelKey = hardened ? 'chat.mode.statusHardened' : 'chat.mode.statusPrf';
    return html`
      <span
        class=${hardened ? 'mode-status-badge mode-status-badge--hardened' : 'mode-status-badge'}
        data-testid="mode-status-badge"
        data-my-mode=${my}
        data-peer-mode=${peer}
        aria-label=${t(labelKey)}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          ${hardened ? lockClosedIcon : lockOpenIcon}
        </svg>
      </span>
    `;
  }
}

customElements.define('mode-status-badge', ModeStatusBadge);

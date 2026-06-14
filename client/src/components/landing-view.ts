import { base64urlEncode } from '@unseen/shared/crypto/encoding.ts';
import { html, LitElement, nothing, svg } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';

import { UNSEEN_LOGO_VIEW_BOX, UNSEEN_LOGO_VIEWBOX_WIDTH } from '../assets/unseen-logo-meta.ts';
import { lang, t } from '../i18n/lang.ts';
import { sweepAllOpaqueDirsForBfcache } from '../storage/opfs-transfers.ts';
import { versionStamp } from './version-stamp.ts';
import './language-toggle.ts';

const SECRET_LENGTH = 32;

const LOGO_VIEW_BOX = UNSEEN_LOGO_VIEW_BOX;
const LOGO_VIEWBOX_WIDTH = UNSEEN_LOGO_VIEWBOX_WIDTH;
const LOGO_FORWARD_SPREAD_MS = 900;
const LOGO_JITTER_MS = 150;
const LOGO_TX_MIN = 4;
const LOGO_TX_MAX = 24;
const LOGO_TY_MIN = -32;
const LOGO_TY_MAX = -6;
const LOGO_ROT_MIN = -25;
const LOGO_ROT_MAX = 25;

const arrowIcon = svg`
  <path
    d="M4 10h11M11 5.5 15.5 10 11 14.5"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
`;

const lockIcon = svg`
  <rect
    x="4.5"
    y="9"
    width="11"
    height="8"
    rx="1.5"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
  />
  <path
    d="M7 9V6.5a3 3 0 0 1 6 0V9"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
  />
`;

const clockIcon = svg`
  <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <path
    d="M10 6.5V10l2.5 1.5"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
`;

export class LandingView extends LitElement {
  #subs?: AbortController;
  #logoSvgInner: string | undefined;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subs = new AbortController();
    const { signal } = this.#subs;
    lang.subscribe(() => this.requestUpdate(), { signal });
    void sweepAllOpaqueDirsForBfcache();
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
    await this.updateComplete;
    this.#initLogoStagger();
  }

  #initLogoStagger(): void {
    const paths = this.querySelectorAll<SVGPathElement>('.landing__logo-svg path');
    // read all geometry first: one layout flush, not one per path
    const xNorms = Array.from(paths, (path) => {
      const box = path.getBBox();
      return (box.x + box.width / 2) / LOGO_VIEWBOX_WIDTH;
    });
    // then write only, no interleaved read, to avoid a synchronous reflow
    for (const [index, path] of paths.entries()) {
      const baseDelay = (xNorms[index] ?? 0) * LOGO_FORWARD_SPREAD_MS;
      const jitter = (Math.random() - 0.5) * 2 * LOGO_JITTER_MS;
      const totalDelay = Math.max(0, baseDelay + jitter);
      const txMag = LOGO_TX_MIN + Math.random() * (LOGO_TX_MAX - LOGO_TX_MIN);
      const txSign = Math.random() > 0.5 ? 1 : -1;
      const tx = txMag * txSign;
      const ty = LOGO_TY_MIN + Math.random() * (LOGO_TY_MAX - LOGO_TY_MIN);
      const rot = LOGO_ROT_MIN + Math.random() * (LOGO_ROT_MAX - LOGO_ROT_MIN);
      path.style.transitionDelay = `${totalDelay.toFixed(0)}ms`;
      path.style.setProperty('--tx', `${tx.toFixed(1)}px`);
      path.style.setProperty('--ty', `${ty.toFixed(1)}px`);
      path.style.setProperty('--r', `${rot.toFixed(1)}deg`);
    }
  }

  readonly #onCreate = (): void => {
    const secret = new Uint8Array(SECRET_LENGTH);
    crypto.getRandomValues(secret);
    const url = `/r402#${base64urlEncode(secret)}`;
    globalThis.location.assign(url);
  };

  override render(): unknown {
    return html`
      <main class="landing">
        <div class="landing__inner">
          <h1 class="landing__logo" data-testid="landing-logo">
            <span class="sr-only">Unseen — private chat</span>
            <svg viewBox=${LOGO_VIEW_BOX} class="landing__logo-svg" aria-hidden="true">
              ${this.#logoSvgInner === undefined ? nothing : unsafeSVG(this.#logoSvgInner)}
            </svg>
          </h1>
          <p class="landing__tagline">${t('landing.tagline')}</p>
          <button
            type="button"
            class="landing__create"
            data-testid="create-room"
            @click=${this.#onCreate}
          >
            <span>${t('landing.createButton')}</span>
            <svg class="landing__create-arrow" viewBox="0 0 20 20" aria-hidden="true">
              ${arrowIcon}
            </svg>
          </button>
          <ul class="landing__signals">
            <li class="landing__signal">
              <svg class="landing__signal-icon" viewBox="0 0 20 20" aria-hidden="true">
                ${lockIcon}
              </svg>
              <span>${t('landing.signalEncrypted')}</span>
            </li>
            <li class="landing__signal">
              <svg class="landing__signal-icon" viewBox="0 0 20 20" aria-hidden="true">
                ${clockIcon}
              </svg>
              <span>${t('landing.signalOneTime')}</span>
            </li>
          </ul>
        </div>
        <footer class="landing__footer">
          <language-toggle></language-toggle>
          <p class="landing__footer-note">${t('landing.footerNote')} ${versionStamp()}</p>
        </footer>
      </main>
    `;
  }
}

customElements.define('landing-view', LandingView);

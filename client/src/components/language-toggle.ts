import { html, LitElement } from 'lit';

import { lang, type Lang, t } from '../i18n/lang.ts';

export class LanguageToggle extends LitElement {
  #subs?: AbortController;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subs = new AbortController();
    const { signal } = this.#subs;
    lang.subscribe(
      () => {
        globalThis.document.documentElement.lang = lang.value;
        this.requestUpdate();
      },
      { signal },
    );
    globalThis.document.documentElement.lang = lang.value;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#subs?.abort();
  }

  readonly #pick = (next: Lang): void => {
    lang.value = next;
  };

  override render(): unknown {
    return html`
      <div class="language-toggle" role="group" aria-label=${t('langToggle.label')}>
        <button
          type="button"
          data-testid="lang-en"
          lang="en"
          aria-label=${t('langToggle.enName')}
          aria-pressed=${lang.value === 'en' ? 'true' : 'false'}
          @click=${(): void => this.#pick('en')}
        >
          en
        </button>
        <button
          type="button"
          data-testid="lang-ru"
          lang="ru"
          aria-label=${t('langToggle.ruName')}
          aria-pressed=${lang.value === 'ru' ? 'true' : 'false'}
          @click=${(): void => this.#pick('ru')}
        >
          ру
        </button>
      </div>
    `;
  }
}

customElements.define('language-toggle', LanguageToggle);

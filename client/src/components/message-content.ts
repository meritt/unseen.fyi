import { html, LitElement, type PropertyValues } from 'lit';

import { type MarkdownAst, parseMarkdown } from '../domain/markdown.ts';
import { renderAst } from '../domain/render-ast.ts';
import { sanitizeUnicode } from '../domain/unicode-sanitize.ts';

export class MessageContent extends LitElement {
  static override properties = {
    source: { type: String },
    _ast: { state: true },
    _error: { state: true },
  };

  declare source: string;
  declare _ast: MarkdownAst | undefined;
  declare _error: boolean;

  constructor() {
    super();
    this.source = '';
    this._ast = undefined;
    this._error = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('source')) {
      const requested = this.source;
      this._ast = undefined;
      this._error = false;
      void this.#loadAst(requested);
    }
  }

  async #loadAst(requested: string): Promise<void> {
    try {
      const ast = await parseMarkdown(requested);
      if (this.source === requested) {
        this._ast = ast;
      }
    } catch {
      if (this.source === requested) {
        this._error = true;
      }
    }
  }

  override render(): unknown {
    if (this._error || this._ast === undefined) {
      return html`<span class="md-pending-text">${sanitizeUnicode(this.source)}</span>`;
    }
    if (this._ast.bombFallback) {
      return html`
        <span class="md-fallback-warning">too complex to render</span>
        <span class="md-fallback-text">${this._ast.source}</span>
      `;
    }
    return renderAst(this._ast.nodes);
  }
}

customElements.define('message-content', MessageContent);

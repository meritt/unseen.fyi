import { html, type TemplateResult } from 'lit';

import type { MarkdownNode } from './markdown-impl.ts';
import { ZERO_WIDTH_RE } from './unicode-sanitize.ts';

const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

type RenderableUrl = {
  readonly safeHref: string;
  readonly displayUrl: string;
};

const buildDisplayUrl = (parsed: URL): string => {
  const tail = parsed.pathname + parsed.search + parsed.hash;
  const normalized = tail === '/' ? '' : tail;
  return parsed.host + normalized;
};

const parseSafeUrl = (raw: string): RenderableUrl | undefined => {
  const parsed = URL.parse(raw);
  if (parsed === null || !ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    return undefined;
  }
  return { safeHref: parsed.toString(), displayUrl: buildDisplayUrl(parsed) };
};

const renderTextWithZeroWidthMarkers = (value: string): TemplateResult | string => {
  if (!ZERO_WIDTH_RE.test(value)) {
    return value;
  }
  const fragments: Array<TemplateResult | string> = [];
  let buffer = '';
  for (const ch of value) {
    if (ZERO_WIDTH_RE.test(ch)) {
      if (buffer !== '') {
        fragments.push(buffer);
        buffer = '';
      }
      fragments.push(html`<span class="zw-marker" aria-label="zero-width">${ch}</span>`);
      continue;
    }
    buffer += ch;
  }
  if (buffer !== '') {
    fragments.push(buffer);
  }
  return html`${fragments}`;
};

const renderNode = (node: MarkdownNode): TemplateResult | string => {
  if (node.type === 'text') {
    return renderTextWithZeroWidthMarkers(node.value);
  }
  if (node.type === 'break') {
    return html`<br />`;
  }
  if (node.type === 'code') {
    return html`<code class="md-code">${renderTextWithZeroWidthMarkers(node.value)}</code>`;
  }
  if (node.type === 'codeBlock') {
    return html`<pre class="md-code-block"><code
        >${renderTextWithZeroWidthMarkers(node.value)}</code
      ></pre>`;
  }
  if (node.type === 'strong') {
    return html`<strong>${node.children.map((child) => renderNode(child))}</strong>`;
  }
  if (node.type === 'emphasis') {
    return html`<em>${node.children.map((child) => renderNode(child))}</em>`;
  }
  const safe = parseSafeUrl(node.url);
  if (safe === undefined) {
    return `[${node.text}](${node.url})`;
  }
  if (node.text === node.url) {
    return html`<a href=${safe.safeHref} target="_blank" rel="noreferrer">${safe.displayUrl}</a>`;
  }
  return html`<a href=${safe.safeHref} target="_blank" rel="noreferrer"
    >${node.text} → ${safe.displayUrl}</a
  >`;
};

export const renderAst = (nodes: readonly MarkdownNode[]): TemplateResult =>
  html`${nodes.map((node) => renderNode(node))}`;

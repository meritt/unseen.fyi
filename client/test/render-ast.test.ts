import { describe, expect, test } from 'bun:test';

import type { TemplateResult } from 'lit';

import type { MarkdownNode } from '../src/domain/markdown-impl.ts';
import { renderAst } from '../src/domain/render-ast.ts';

const collectStrings = (result: TemplateResult): string => {
  const seen = new Set<TemplateResult>();
  const walk = (value: unknown): string => {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item)).join('');
    }
    if (value !== null && typeof value === 'object' && '_$litType$' in value) {
      const template = value as TemplateResult;
      if (seen.has(template)) {
        return '';
      }
      seen.add(template);
      const { strings, values } = template;
      let combined = '';
      for (let i = 0; i < strings.length; i++) {
        combined += strings[i] ?? '';
        if (i < values.length) {
          combined += walk(values[i]);
        }
      }
      return combined;
    }
    return '';
  };
  return walk(result);
};

const text = (value: string): MarkdownNode => ({ type: 'text', value });

describe('renderAst — Lit template output', () => {
  test('plain text passes through untouched', () => {
    const out = renderAst([text('hello world')]);
    expect(collectStrings(out)).toContain('hello world');
  });

  test('JS-scheme link is rendered as literal markdown text, no <a>', () => {
    const jsUrl = ['java', 'script:alert(1)'].join('');
    const out = renderAst([{ type: 'link', text: 'click', url: jsUrl }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain(`[click](${jsUrl})`);
    expect(rendered).not.toContain('<a');
  });

  test('data: link is rendered as plain text', () => {
    const out = renderAst([
      { type: 'link', text: 'click', url: 'data:text/html,<svg/onload=alert(1)>' },
    ]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('[click](data:text/html,<svg/onload=alert(1)>)');
    expect(rendered).not.toContain('<a');
  });

  test('mailto: and file: links are not anchored', () => {
    const mailto = collectStrings(renderAst([{ type: 'link', text: 'write', url: 'mailto:a@b' }]));
    expect(mailto).toContain('[write](mailto:a@b)');
    expect(mailto).not.toContain('<a');

    const file = collectStrings(
      renderAst([{ type: 'link', text: 'open', url: 'file:///etc/passwd' }]),
    );
    expect(file).toContain('[open](file:///etc/passwd)');
    expect(file).not.toContain('<a');
  });

  test('labeled https link shows text → host + full path', () => {
    const out = renderAst([{ type: 'link', text: 'pay', url: 'https://xn--80ak6aa92e.com/path' }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('<a');
    expect(rendered).toContain('pay');
    expect(rendered).toContain('xn--80ak6aa92e.com/path');
    expect(rendered).toContain('→');
  });

  test('auto-linked bare URL (text === url) renders verbatim without → suffix', () => {
    const url = 'https://github.com/basecamp';
    const out = renderAst([{ type: 'link', text: url, url }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('<a');
    expect(rendered).toContain(url);
    expect(rendered).not.toContain('→');
  });

  test('strong wraps children in <strong>', () => {
    const out = renderAst([{ type: 'strong', children: [text('bold!')] }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('<strong>');
    expect(rendered).toContain('bold!');
  });

  test('inline code keeps raw value (escaping happens at Lit binding)', () => {
    const out = renderAst([{ type: 'code', value: '<script>alert(1)</script>' }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('<code class="md-code">');
    expect(rendered).toContain('<script>alert(1)</script>');
  });

  test('zero-width characters get wrapped in a marker span', () => {
    const out = renderAst([text('paypal​.com')]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('zw-marker');
  });

  test('invisible characters inside inline code get a marker span', () => {
    const out = renderAst([{ type: 'code', value: 'rm\u2060 -rf' }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('<code class="md-code">');
    expect(rendered).toContain('zw-marker');
  });

  test('invisible characters inside a code block get a marker span', () => {
    const out = renderAst([{ type: 'codeBlock', value: 'line\u200Bone' }]);
    const rendered = collectStrings(out);
    expect(rendered).toContain('md-code-block');
    expect(rendered).toContain('zw-marker');
  });
});

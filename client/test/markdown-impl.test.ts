import { describe, expect, test } from 'bun:test';

import { type MarkdownNode, parseMarkdownString } from '../src/domain/markdown-impl.ts';

const textValue = (node: MarkdownNode): string => {
  if (node.type === 'text') {
    return node.value;
  }
  if (node.type === 'link') {
    return node.text;
  }
  if (node.type === 'code') {
    return node.value;
  }
  if (node.type === 'strong' || node.type === 'emphasis') {
    return node.children.map((child) => textValue(child)).join('');
  }
  return '';
};

describe('markdown subset parser', () => {
  test('bold via **...** becomes a strong node', () => {
    const ast = parseMarkdownString('**hi**');
    expect(ast.bombFallback).toBe(false);
    expect(ast.nodes).toHaveLength(1);
    const node = ast.nodes[0]!;
    expect(node.type).toBe('strong');
    expect(textValue(node)).toBe('hi');
  });

  test('italic via *...* becomes an emphasis node', () => {
    const ast = parseMarkdownString('*hi*');
    expect(ast.nodes[0]).toEqual({
      type: 'emphasis',
      children: [{ type: 'text', value: 'hi' }],
    });
  });

  test('italic via _..._ also produces emphasis', () => {
    const ast = parseMarkdownString('_hi_');
    expect(ast.nodes[0]?.type).toBe('emphasis');
  });

  test('inline code wraps raw value untouched (including special chars)', () => {
    const ast = parseMarkdownString('`<script>` *literal*');
    expect(ast.nodes[0]).toEqual({ type: 'code', value: '<script>' });
  });

  test('link captures text and url separately', () => {
    const ast = parseMarkdownString('[example](https://example.com)');
    expect(ast.nodes[0]).toEqual({
      type: 'link',
      text: 'example',
      url: 'https://example.com',
    });
  });

  test('newline emits a break node', () => {
    const ast = parseMarkdownString('a\nb');
    expect(ast.nodes.map((node) => node.type)).toEqual(['text', 'break', 'text']);
  });

  test('raw HTML never produces tag nodes, just literal text', () => {
    const ast = parseMarkdownString('<script>alert(1)</script>');
    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0]).toEqual({
      type: 'text',
      value: '<script>alert(1)</script>',
    });
  });

  test('unmatched markers are kept verbatim as text', () => {
    const ast = parseMarkdownString('**unclosed bold and *italic_');
    const flattened = ast.nodes.map((node) => textValue(node)).join('');
    expect(flattened).toContain('**unclosed bold');
  });

  test('escape with backslash makes the next character literal', () => {
    const ast = parseMarkdownString(String.raw`\*not italic\*`);
    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0]).toEqual({ type: 'text', value: '*not italic*' });
  });

  test('nested emphasis inside strong is allowed within the depth cap', () => {
    const ast = parseMarkdownString('**a *b* c**');
    expect(ast.bombFallback).toBe(false);
    expect(ast.nodes).toHaveLength(1);
    const strong = ast.nodes[0]!;
    expect(strong.type).toBe('strong');
  });

  test('token-cap fallback fires only past the 500-token ceiling', () => {
    const fine = Array.from({ length: 100 }, (_, i) => `**${String(i)}**`).join(' ');
    expect(parseMarkdownString(fine).bombFallback).toBe(false);

    const stressed = Array.from({ length: 700 }, (_, i) => `**${String(i)}**`).join(' ');
    expect(parseMarkdownString(stressed).bombFallback).toBe(true);
  });

  test('exposes sanitized source so callers can fall back to plain text', () => {
    const raw = `before‮after`;
    const ast = parseMarkdownString(raw);
    expect(ast.source).toBe('beforeafter');
  });

  test.each([
    ['#', 'h1'],
    ['##', 'h2'],
    ['###', 'h3'],
    ['####', 'h4'],
    ['#####', 'h5'],
    ['######', 'h6'],
  ])('heading %s … is rewritten to a strong node (%s)', (marker) => {
    const ast = parseMarkdownString(`${marker} Title text`);
    expect(ast.bombFallback).toBe(false);
    expect(ast.nodes).toHaveLength(1);
    const node = ast.nodes[0]!;
    expect(node.type).toBe('strong');
    expect(node.type === 'strong' ? node.children[0] : undefined).toEqual({
      type: 'text',
      value: 'Title text',
    });
  });

  test('heading marker without trailing space is left as plain text', () => {
    const ast = parseMarkdownString('###no-space-after');
    expect(ast.nodes[0]?.type).toBe('text');
  });

  test('heading marker mid-line is left as plain text', () => {
    const ast = parseMarkdownString('hello ## not-a-heading');
    expect(ast.nodes[0]?.type).toBe('text');
  });

  test('fenced code block produces a single codeBlock node preserving raw content', () => {
    const source = '```\nconst x = 1;\nconst y = 2;\n```';
    const ast = parseMarkdownString(source);
    expect(ast.bombFallback).toBe(false);
    expect(ast.nodes).toHaveLength(1);
    const node = ast.nodes[0]!;
    expect(node.type).toBe('codeBlock');
    expect(node.type === 'codeBlock' ? node.value : '').toBe('const x = 1;\nconst y = 2;');
  });

  test('fenced code block keeps inner markdown verbatim (no nested parsing)', () => {
    const ast = parseMarkdownString('```\n**still-bold**\n```');
    const node = ast.nodes[0]!;
    expect(node.type).toBe('codeBlock');
    expect(node.type === 'codeBlock' ? node.value : '').toBe('**still-bold**');
  });

  test('unterminated fence is treated as literal inline text', () => {
    const ast = parseMarkdownString('```\nstuck without close');
    expect(ast.nodes.every((n) => n.type !== 'codeBlock')).toBe(true);
  });

  test('mixed prose, heading, and code block round-trip cleanly', () => {
    const ast = parseMarkdownString('before\n## title\n```\ncode\n```\nafter');
    const kinds = ast.nodes.map((n) => n.type);
    expect(kinds).toContain('codeBlock');
    expect(kinds).toContain('strong');
  });
});

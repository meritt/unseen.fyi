import { describe, expect, test } from 'bun:test';

import { minifyHtml } from '../build.ts';

describe('minifyHtml', () => {
  test('collapses formatter-wrapped tag attributes onto one line', () => {
    const input = '<meta name="description"\n    content="Private chat">';
    expect(minifyHtml(input)).toBe('<meta name="description" content="Private chat">');
  });

  test('removes whitespace-only text between tags', () => {
    const input = '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>';
    expect(minifyHtml(input)).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  test('keeps a single space before text inside an element', () => {
    const input = '<div>\n  Connecting</div>';
    expect(minifyHtml(input)).toBe('<div> Connecting</div>');
  });

  test('collapses a raw element opening tag but preserves its body verbatim', () => {
    const input = '<textarea class="f"\n    rows="1">  keep\n  me  </textarea>';
    expect(minifyHtml(input)).toBe('<textarea class="f" rows="1">  keep\n  me  </textarea>');
  });

  test('preserves pre body whitespace', () => {
    const input = '<pre>\n  line1\n  line2\n</pre>';
    expect(minifyHtml(input)).toBe('<pre>\n  line1\n  line2\n</pre>');
  });

  test('joins doctype and blank lines into a single stream', () => {
    const input = '<!doctype html>\n<html lang="en">\n\n<head></head>\n</html>';
    expect(minifyHtml(input)).toBe('<!doctype html><html lang="en"><head></head></html>');
  });

  test('does not touch numeric attribute values (sentinel safety)', () => {
    const input = '<rect x="4.5" y="9" width="11" height="8"></rect>';
    expect(minifyHtml(input)).toBe('<rect x="4.5" y="9" width="11" height="8"></rect>');
  });
});

import { sanitizeUnicode } from './unicode-sanitize.ts';

export type MarkdownNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'strong'; readonly children: readonly MarkdownNode[] }
  | { readonly type: 'emphasis'; readonly children: readonly MarkdownNode[] }
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'codeBlock'; readonly value: string }
  | { readonly type: 'link'; readonly url: string; readonly text: string }
  | { readonly type: 'break' };

export type MarkdownAst = {
  readonly nodes: readonly MarkdownNode[];
  readonly bombFallback: boolean;
  readonly source: string;
};

const MAX_TOKENS = 500;
const MAX_EMPHASIS_DEPTH = 3;
const HEADING_RE = /^#{1,6}[ \t]+(?<heading>.+)$/u;
const FENCE_OPEN_RE = /^```[ \t]*[^\n]*$/u;
const FENCE_CLOSE_LITERAL = '```';

type Cursor = {
  readonly source: string;
  pos: number;
  tokens: number;
  depth: number;
  overflow: boolean;
};

export function parseMarkdownString(raw: string): MarkdownAst {
  const source = sanitizeUnicode(raw);
  const segments = splitBlocks(source);
  const accumulator: { nodes: MarkdownNode[]; tokens: number; overflow: boolean } = {
    nodes: [],
    tokens: 0,
    overflow: false,
  };
  for (const segment of segments) {
    if (accumulator.tokens >= MAX_TOKENS) {
      accumulator.overflow = true;
      break;
    }
    if (segment.kind === 'code-block') {
      accumulator.nodes.push({ type: 'codeBlock', value: segment.value });
      accumulator.tokens += 1;
      continue;
    }
    const cursor: Cursor = {
      source: rewriteHeadings(segment.value),
      pos: 0,
      tokens: accumulator.tokens,
      depth: 0,
      overflow: accumulator.overflow,
    };
    const inlineNodes = parseInline(cursor);
    accumulator.nodes.push(...inlineNodes);
    accumulator.tokens = cursor.tokens;
    accumulator.overflow = cursor.overflow;
  }
  return { nodes: accumulator.nodes, bombFallback: accumulator.overflow, source };
}

type BlockSegment =
  | { readonly kind: 'inline'; readonly value: string }
  | { readonly kind: 'code-block'; readonly value: string };

function splitBlocks(source: string): BlockSegment[] {
  const segments: BlockSegment[] = [];
  const lines = source.split('\n');
  let buffer: string[] = [];
  let i = 0;
  const flushInline = (): void => {
    if (buffer.length === 0) {
      return;
    }
    segments.push({ kind: 'inline', value: buffer.join('\n') });
    buffer = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (FENCE_OPEN_RE.test(line)) {
      const closeIdx = findFenceClose(lines, i + 1);
      if (closeIdx === -1) {
        buffer.push(line);
        i += 1;
        continue;
      }
      flushInline();
      const codeLines = lines.slice(i + 1, closeIdx);
      segments.push({ kind: 'code-block', value: codeLines.join('\n') });
      i = closeIdx + 1;
      continue;
    }
    buffer.push(line);
    i += 1;
  }
  flushInline();
  return segments;
}

function findFenceClose(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trimEnd() === FENCE_CLOSE_LITERAL) {
      return i;
    }
  }
  return -1;
}

function rewriteHeadings(segment: string): string {
  return segment
    .split('\n')
    .map((line) => line.replace(HEADING_RE, '**$1**'))
    .join('\n');
}

function parseInline(cursor: Cursor): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let buffer = '';

  const flushBuffer = (): void => {
    if (buffer === '') {
      return;
    }
    emit(cursor, { type: 'text', value: buffer }, nodes);
    buffer = '';
  };

  while (cursor.pos < cursor.source.length) {
    if (cursor.tokens >= MAX_TOKENS) {
      cursor.overflow = true;
      break;
    }
    const ch = cursor.source[cursor.pos];
    if (ch === undefined) {
      break;
    }

    if (ch === '\\') {
      const next = cursor.source[cursor.pos + 1];
      if (next !== undefined) {
        buffer += next;
        cursor.pos += 2;
        continue;
      }
    }

    if (ch === '\n') {
      flushBuffer();
      emit(cursor, { type: 'break' }, nodes);
      cursor.pos += 1;
      continue;
    }

    const token = tryConsumeToken(cursor, ch);
    if (token !== undefined) {
      flushBuffer();
      emit(cursor, token, nodes);
      continue;
    }

    buffer += ch;
    cursor.pos += 1;
  }

  flushBuffer();
  return nodes;
}

function tryConsumeToken(cursor: Cursor, ch: string): MarkdownNode | undefined {
  if (ch === '`') {
    return tryConsumeCode(cursor);
  }
  if (ch === '*' || ch === '_') {
    return tryConsumeEmphasis(cursor, ch);
  }
  if (ch === '[') {
    return tryConsumeLink(cursor);
  }
  if (ch === 'h') {
    return tryConsumeAutolink(cursor);
  }
  return undefined;
}

function emit(cursor: Cursor, node: MarkdownNode, sink: MarkdownNode[]): void {
  const last = sink.at(-1);
  if (node.type === 'text' && last?.type === 'text') {
    sink[sink.length - 1] = { type: 'text', value: last.value + node.value };
    return;
  }
  sink.push(node);
  cursor.tokens += 1;
}

function tryConsumeCode(cursor: Cursor): MarkdownNode | undefined {
  const start = cursor.pos;
  let openTicks = 0;
  while (cursor.source[start + openTicks] === '`') {
    openTicks += 1;
  }
  const contentStart = start + openTicks;
  let searchFrom = contentStart;
  while (searchFrom < cursor.source.length) {
    const closeIdx = cursor.source.indexOf('`'.repeat(openTicks), searchFrom);
    if (closeIdx === -1) {
      return undefined;
    }
    let closeTicks = 0;
    while (cursor.source[closeIdx + closeTicks] === '`') {
      closeTicks += 1;
    }
    if (closeTicks === openTicks) {
      const value = cursor.source.slice(contentStart, closeIdx);
      cursor.pos = closeIdx + openTicks;
      return { type: 'code', value };
    }
    searchFrom = closeIdx + closeTicks;
  }
  return undefined;
}

function tryConsumeEmphasis(cursor: Cursor, marker: '*' | '_'): MarkdownNode | undefined {
  if (cursor.depth >= MAX_EMPHASIS_DEPTH) {
    cursor.overflow = true;
    return undefined;
  }
  const start = cursor.pos;
  let runLength = 0;
  while (cursor.source[start + runLength] === marker) {
    runLength += 1;
  }
  const wantStrong = runLength >= 2;
  const openLength = wantStrong ? 2 : 1;
  const innerStart = start + openLength;
  const innerHead = cursor.source[innerStart];
  if (innerHead === undefined || innerHead === ' ') {
    return undefined;
  }
  const closer = marker.repeat(openLength);
  let search = innerStart;
  while (search < cursor.source.length) {
    const idx = cursor.source.indexOf(closer, search);
    if (idx === -1) {
      return undefined;
    }
    const prev = cursor.source[idx - 1];
    if (prev !== ' ' && prev !== '\n') {
      cursor.pos = innerStart;
      cursor.depth += 1;
      const innerCursor: Cursor = {
        source: cursor.source.slice(0, idx),
        pos: innerStart,
        tokens: cursor.tokens,
        depth: cursor.depth,
        overflow: cursor.overflow,
      };
      const children = parseInline(innerCursor);
      cursor.tokens = innerCursor.tokens;
      cursor.overflow = innerCursor.overflow || cursor.overflow;
      cursor.depth -= 1;
      cursor.pos = idx + openLength;
      return wantStrong ? { type: 'strong', children } : { type: 'emphasis', children };
    }
    search = idx + closer.length;
  }
  return undefined;
}

const AUTOLINK_PREFIX_RE = /^https?:\/\//u;
const AUTOLINK_PREV_BOUNDARY_RE = /[a-zA-Z0-9]/u;
const AUTOLINK_TERMINATORS = new Set([' ', '\t', '\n', '<', '>']);
const AUTOLINK_TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', ')']);

function tryConsumeAutolink(cursor: Cursor): MarkdownNode | undefined {
  const slice = cursor.source.slice(cursor.pos);
  const prefixMatch = slice.match(AUTOLINK_PREFIX_RE);
  if (prefixMatch === null) {
    return undefined;
  }
  const prev = cursor.source[cursor.pos - 1];
  if (prev !== undefined && AUTOLINK_PREV_BOUNDARY_RE.test(prev)) {
    return undefined;
  }
  const startBody = cursor.pos + prefixMatch[0].length;
  let end = scanAutolinkEnd(cursor.source, startBody);
  end = trimAutolinkTail(cursor.source, startBody, end);
  if (end <= startBody) {
    return undefined;
  }
  const url = cursor.source.slice(cursor.pos, end);
  cursor.pos = end;
  return { type: 'link', url, text: url };
}

function scanAutolinkEnd(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const c = source[i];
    if (c === undefined || AUTOLINK_TERMINATORS.has(c)) {
      break;
    }
    i += 1;
  }
  return i;
}

function trimAutolinkTail(source: string, floor: number, end: number): number {
  let i = end;
  while (i > floor) {
    const last = source[i - 1];
    if (last === undefined || !AUTOLINK_TRAILING_PUNCT.has(last)) {
      break;
    }
    i -= 1;
  }
  return i;
}

function tryConsumeLink(cursor: Cursor): MarkdownNode | undefined {
  const start = cursor.pos;
  const textEnd = findUnescaped(cursor.source, start + 1, ']');
  if (textEnd === -1 || cursor.source[textEnd + 1] !== '(') {
    return undefined;
  }
  const urlEnd = findUnescaped(cursor.source, textEnd + 2, ')');
  if (urlEnd === -1) {
    return undefined;
  }
  const text = cursor.source.slice(start + 1, textEnd);
  const url = cursor.source.slice(textEnd + 2, urlEnd).trim();
  if (text === '' || url === '') {
    return undefined;
  }
  cursor.pos = urlEnd + 1;
  return { type: 'link', url, text };
}

function findUnescaped(source: string, start: number, target: string): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === target) {
      return i;
    }
    i += 1;
  }
  return -1;
}

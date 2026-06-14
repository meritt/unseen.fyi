import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { en } from '../src/i18n/en.ts';
import { lang, t } from '../src/i18n/lang.ts';
import { ru } from '../src/i18n/ru.ts';
import { sasEntryForByte, sasNameForByte, SAS_POOL_SIZE } from '../src/i18n/sas-emoji.ts';

const collectKeys = (obj: unknown, prefix: string, acc: Set<string>): void => {
  if (obj === null || typeof obj !== 'object') {
    acc.add(prefix);
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    collectKeys(value, prefix === '' ? key : `${prefix}.${key}`, acc);
  }
};

// messages carry intentional non-breaking spaces; normalize before content checks
const normalizeSpaces = (value: string): string => value.replaceAll('\u00A0', ' ');

const originalLang = lang.value;

beforeEach(() => {
  lang.value = 'en';
});

afterEach(() => {
  lang.value = originalLang;
});

describe('t() dictionary lookup', () => {
  test('returns localized string for a known key', () => {
    expect(normalizeSpaces(t('chat.system.sessionStarted'))).toBe(
      'Session started. Messages disappear after this session.',
    );
    lang.value = 'ru';
    expect(normalizeSpaces(t('chat.system.sessionStarted'))).toBe(
      'Сессия начата. Сообщения исчезнут после её окончания.',
    );
  });

  test('substitutes {placeholders} from vars', () => {
    expect(normalizeSpaces(t('chat.newMessages', { count: 3 }))).toBe('3 new ↓');
  });

  test('returns the key itself when the path is missing and warns', () => {
    const original = globalThis.console.warn;
    const calls: unknown[][] = [];
    globalThis.console.warn = (...args: unknown[]): void => {
      calls.push(args);
    };
    try {
      expect(t('does.not.exist')).toBe('does.not.exist');
      expect(calls.length).toBe(1);
    } finally {
      globalThis.console.warn = original;
    }
  });
});

describe('i18n dict shape', () => {
  test('every EN leaf key has a RU counterpart', () => {
    const enKeys = new Set<string>();
    const ruKeys = new Set<string>();
    collectKeys(en, '', enKeys);
    collectKeys(ru, '', ruKeys);
    const missingInRu = [...enKeys].filter((k) => !ruKeys.has(k));
    expect(missingInRu).toEqual([]);
  });

  test('EN file transfer keys present', () => {
    expect(normalizeSpaces(en.chat.fileTransfer.attachAria)).toBe('Attach a file');
  });

  test('RU file transfer keys present', () => {
    expect(normalizeSpaces(ru.chat.fileTransfer.attachAria)).toBe('Прикрепить файл');
  });
});

describe('SAS emoji pool', () => {
  test('pool has 256 entries with sequential bytes', () => {
    expect(SAS_POOL_SIZE).toBe(256);
    for (let i = 0; i < SAS_POOL_SIZE; i++) {
      const entry = sasEntryForByte(i);
      expect(entry.byte).toBe(i);
      expect(entry.emoji.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
      expect(entry.ru.length).toBeGreaterThan(0);
    }
  });

  test('localizedName follows the active lang', () => {
    expect(sasNameForByte(0)).toBe('Turtle');
    lang.value = 'ru';
    expect(sasNameForByte(0)).toBe('Черепаха');
  });

  test('out-of-range byte throws', () => {
    expect(() => sasEntryForByte(-1)).toThrow();
    expect(() => sasEntryForByte(256)).toThrow();
    expect(() => sasEntryForByte(1.5)).toThrow();
  });
});

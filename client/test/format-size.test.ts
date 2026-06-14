import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { formatSize } from '../src/i18n/format-size.ts';
import { lang } from '../src/i18n/lang.ts';

const originalLang = lang.value;

beforeEach(() => {
  lang.value = 'en';
});

afterEach(() => {
  lang.value = originalLang;
});

describe('formatSize — bytes bracket (EN, decimal 1000-based)', () => {
  test('zero bytes', () => {
    expect(formatSize(0)).toBe('0 byte');
  });

  test('boundary just below 1 kB stays in bytes', () => {
    expect(formatSize(999)).toBe('999 byte');
  });

  test('fractional input truncates for bytes display', () => {
    expect(formatSize(0.7)).toBe('0 byte');
  });

  test('negative input clamps to zero', () => {
    expect(formatSize(-42)).toBe('0 byte');
  });
});

describe('formatSize — kB / MB / GB brackets (EN)', () => {
  test('1000 crosses into kB', () => {
    expect(formatSize(1000)).toBe('1.0 kB');
  });

  test('1.5 kB to one decimal', () => {
    expect(formatSize(1500)).toBe('1.5 kB');
  });

  test('first MB renders as 1.0', () => {
    expect(formatSize(1_000_000)).toBe('1.0 MB');
  });

  test('13.0 MB to one decimal', () => {
    expect(formatSize(13_002_342)).toBe('13.0 MB');
  });

  test('first GB to two decimals', () => {
    expect(formatSize(1_073_741_824)).toBe('1.07 GB');
  });

  test('2.68 GB to two decimals', () => {
    expect(formatSize(2_684_354_560)).toBe('2.68 GB');
  });
});

describe('formatSize — RU locale (comma decimal, CLDR labels)', () => {
  beforeEach(() => {
    lang.value = 'ru';
  });

  test('byte / kB / GB labels and comma separator', () => {
    expect(formatSize(500)).toBe('500 Б');
    expect(formatSize(1500)).toBe('1,5 кБ');
    expect(formatSize(2_684_354_560)).toBe('2,68 ГБ');
  });
});

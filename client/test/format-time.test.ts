import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  formatCountdown,
  formatCountdownSpoken,
  formatRelativeTime,
} from '../src/domain/format-time.ts';
import { lang } from '../src/i18n/lang.ts';

const originalLang = lang.value;

const instant = (iso: string): { epochMilliseconds: number } => ({
  epochMilliseconds: new globalThis.Date(iso).getTime(),
});

beforeEach(() => {
  lang.value = 'en';
});

afterEach(() => {
  lang.value = originalLang;
});

describe('formatCountdown', () => {
  test('pads seconds with a leading zero', () => {
    expect(formatCountdown(60_000)).toBe('1:00');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(5 * 60_000)).toBe('5:00');
  });

  test('floors below zero to 0:00', () => {
    expect(formatCountdown(-1000)).toBe('0:00');
  });
});

describe('formatCountdownSpoken', () => {
  test('en picks one / other forms', () => {
    expect(formatCountdownSpoken(1000)).toBe('1 second');
    expect(formatCountdownSpoken(45_000)).toBe('45 seconds');
    expect(formatCountdownSpoken(60_000)).toBe('1 minute');
    expect(formatCountdownSpoken(300_000)).toBe('5 minutes');
  });

  test('ru picks correct CLDR categories', () => {
    lang.value = 'ru';
    expect(formatCountdownSpoken(60_000)).toBe('1 минута');
    expect(formatCountdownSpoken(180_000)).toBe('3 минуты');
    expect(formatCountdownSpoken(300_000)).toBe('5 минут');
  });
});

describe('formatRelativeTime', () => {
  test('returns "just now" within the 5-second threshold', () => {
    const now = instant('2026-05-14T12:00:00.000Z');
    const event = instant('2026-05-14T11:59:58.000Z');
    expect(formatRelativeTime(event, now)).toBe('just now');
    lang.value = 'ru';
    expect(formatRelativeTime(event, now)).toBe('только что');
  });

  test('falls back to RelativeTimeFormat for larger gaps', () => {
    const now = instant('2026-05-14T12:00:00.000Z');
    const event = instant('2026-05-14T11:55:00.000Z');
    const past = formatRelativeTime(event, now);
    expect(past.toLowerCase()).toContain('minute');
  });
});

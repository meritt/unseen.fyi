import { lang, t } from '../i18n/lang.ts';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const JUST_NOW_THRESHOLD_MS = 5000;

export type InstantLike = { readonly epochMilliseconds: number };

const toMs = (instant: InstantLike): number => instant.epochMilliseconds;

export const formatTimeOfDay = (instant: InstantLike): string =>
  new Intl.DateTimeFormat(lang.value, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(toMs(instant));

export const formatRelativeTime = (event: InstantLike, now: InstantLike): string => {
  const deltaMs = Math.abs(toMs(now) - toMs(event));
  if (deltaMs < JUST_NOW_THRESHOLD_MS) {
    return t('time.justNow');
  }
  const rtf = new Intl.RelativeTimeFormat(lang.value, { numeric: 'auto' });
  const futureSign = toMs(now) <= toMs(event) ? 1 : -1;
  if (deltaMs < MS_PER_MINUTE) {
    return rtf.format(Math.floor(deltaMs / MS_PER_SECOND) * futureSign, 'second');
  }
  if (deltaMs < MS_PER_HOUR) {
    return rtf.format(Math.floor(deltaMs / MS_PER_MINUTE) * futureSign, 'minute');
  }
  if (deltaMs < MS_PER_DAY) {
    return rtf.format(Math.floor(deltaMs / MS_PER_HOUR) * futureSign, 'hour');
  }
  return rtf.format(Math.floor(deltaMs / MS_PER_DAY) * futureSign, 'day');
};

export const formatCountdown = (totalMs: number): string => {
  const safe = Math.max(0, Math.floor(totalMs / MS_PER_SECOND));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, '0')}`;
};

export const formatCountdownSpoken = (totalMs: number): string => {
  const safe = Math.max(0, Math.floor(totalMs / MS_PER_SECOND));
  const duration = safe < 60 ? { seconds: safe } : { minutes: Math.floor(safe / 60) };
  return new Intl.DurationFormat(lang.value, { style: 'long' }).format(duration);
};

import { lang } from './lang.ts';

const formatters = new Map<string, Intl.NumberFormat>();

const formatter = (locale: string, unit: string, digits: number): Intl.NumberFormat => {
  const key = `${locale}:${unit}:${String(digits)}`;
  let cached = formatters.get(key);
  if (cached === undefined) {
    cached = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, cached);
  }
  return cached;
};

export const formatSize = (bytes: number): string => {
  const value = Math.max(0, bytes);
  if (value < 1000) {
    return formatter(lang.value, 'byte', 0).format(Math.trunc(value));
  }
  if (value < 1e6) {
    return formatter(lang.value, 'kilobyte', 1).format(value / 1000);
  }
  if (value < 1e9) {
    return formatter(lang.value, 'megabyte', 1).format(value / 1e6);
  }
  return formatter(lang.value, 'gigabyte', 2).format(value / 1e9);
};

import { Signal } from '../state/signal.ts';
import { type Dict, en } from './en.ts';
import { ru } from './ru.ts';

export type Lang = 'en' | 'ru';

const dicts: Record<Lang, Dict> = { en, ru };

export const LANG_STORAGE_KEY = 'c7XmK9-bN4q';

type Nav = { readonly languages?: readonly string[]; readonly language?: string };

const collectLangSources = (nav: Nav): readonly string[] => {
  const out: string[] = [];
  const langs = nav.languages;
  if (Array.isArray(langs)) {
    for (const tag of langs) {
      if (typeof tag === 'string') {
        out.push(tag);
      }
    }
  }
  if (out.length === 0 && typeof nav.language === 'string') {
    out.push(nav.language);
  }
  return out;
};

const detectInitialLang = (): Lang => {
  const nav = (globalThis as { readonly navigator?: Nav }).navigator;
  if (nav === undefined) {
    return 'en';
  }
  for (const tag of collectLangSources(nav)) {
    if (tag.toLowerCase().startsWith('ru')) {
      return 'ru';
    }
  }
  return 'en';
};

const readStoredLang = (): Lang | undefined => {
  try {
    const raw = globalThis.localStorage.getItem(LANG_STORAGE_KEY);
    if (raw === 'en' || raw === 'ru') {
      return raw;
    }
  } catch {}
  return undefined;
};

const writeStoredLang = (value: Lang): void => {
  try {
    globalThis.localStorage.setItem(LANG_STORAGE_KEY, value);
  } catch {}
};

const initialLang = readStoredLang() ?? detectInitialLang();
writeStoredLang(initialLang);

export const lang = new Signal<Lang>(initialLang);

lang.subscribe(() => {
  writeStoredLang(lang.value);
});

const isRecord = (value: unknown): value is { readonly [k: string]: unknown } =>
  value !== null && typeof value === 'object';

const readField = (host: unknown, name: string): unknown => {
  if (!isRecord(host)) {
    return undefined;
  }
  return host[name];
};

const resolveByPath = (key: string): unknown => {
  let cursor: unknown = dicts[lang.value];
  for (const segment of key.split('.')) {
    cursor = readField(cursor, segment);
    if (cursor === undefined) {
      return undefined;
    }
  }
  return cursor;
};

export const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => {
  const value = resolveByPath(key);
  if (typeof value !== 'string') {
    globalThis.console.warn(`Missing translation: ${lang.value}.${key}`);
    return key;
  }
  return value.replaceAll(/\{(?<name>\w+)\}/gu, (_, name: string) => String(vars[name] ?? ''));
};

export type { Dict };

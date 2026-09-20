import { LOCALES, type Locale } from '@portionium/schemas';
import { useSyncExternalStore } from 'react';

import { de } from './locales/de';
import { en } from './locales/en';

export type Dictionary = typeof en;
export type TranslationKey = keyof Dictionary;

interface Plural {
  one: string;
  other: string;
}

function isPlural(entry: Dictionary[TranslationKey]): entry is Plural {
  return typeof entry === 'object';
}

const DICTIONARIES: Record<Locale, Dictionary> = { 'en-US': en, de };

function bestMatch(tags: readonly string[]): Locale | undefined {
  for (const tag of tags) {
    const primary = tag.toLowerCase().split('-')[0];
    const match = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === primary);

    if (match !== undefined) {
      return match;
    }
  }

  return undefined;
}

function browserLocale(): Locale {
  const languages =
    typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);

  return bestMatch(languages) ?? 'en-US';
}

function applyDocumentLang(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

let active: Locale = browserLocale();
applyDocumentLang(active);

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return active;
}

export function setLocale(locale: Locale | null): void {
  const next = locale ?? browserLocale();

  if (next === active) {
    return;
  }

  active = next;
  applyDocumentLang(active);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

function fill(template: string, vars: Record<string, string | number> | undefined): string {
  return vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const entry = DICTIONARIES[locale][key];

  if (!isPlural(entry)) {
    return fill(entry, vars);
  }

  const category = new Intl.PluralRules(locale).select(Number(vars?.count ?? 0));

  return fill(entry[category as keyof Plural] ?? entry.other, vars);
}

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate(active, key, vars);
}

export function useT(): typeof t {
  useLocale();

  return t;
}

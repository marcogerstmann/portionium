import { LOCALES, type Locale } from '@portionium/schemas';
import { useSyncExternalStore } from 'react';

import { de } from './locales/de';
import { en } from './locales/en';

/**
 * The whole of this app's localisation, see POR-64. No i18n dependency: a dictionary is a
 * TypeScript object, a placeholder is `{name}` replaced by a plain string, and the one piece of
 * real logic, picking a plural form, is `Intl.PluralRules`, which both browsers already ship.
 *
 * English is the dictionary every other one is checked against, both by its type (`Dictionary`
 * below, inferred from it) and by i18n.test.ts, which asserts the same keys exist in both so a
 * half translated release fails here rather than on screen.
 *
 * A key resolves to either a plain string or a plural entry, `{ one, other }`. Cardinal only,
 * because English and German agree on needing no more categories than that; a language that
 * needed `few` or `many` would add the key to the type and every dictionary would have to grow
 * one, which is the parity check doing its job.
 */

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

/**
 * Which of LOCALES best matches a browser's own ranked list of languages.
 *
 * Compared on the primary subtag alone, `de` out of `de-AT`, because this product ships one
 * variant of each language rather than one per country, the same simplification LOCALES itself
 * makes.
 */
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

/**
 * The browser's own answer, read fresh every time rather than cached: `setLocale(null)` calls
 * this again, which is what makes "never chosen" mean "follows the browser" rather than "follows
 * whatever it said once". Guarded for a runtime with no `navigator`, which is every unit test
 * below that does not import a DOM, see vite.config.ts's `test.environment`.
 */
function browserLocale(): Locale {
  const languages =
    typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);

  return bestMatch(languages) ?? 'en-US';
}

/** `lang` on the document element, so a screen reader pronounces the active language. */
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

/**
 * Changes the active language for everything subscribed, no reload. `null` is the same choice
 * it is over the wire, see updateProfileRequestSchema: go back to following the browser rather
 * than staying pinned to a language somebody picked before.
 */
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

/** The active language, reactive: a component reading this re-renders when setLocale changes it. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

function fill(template: string, vars: Record<string, string | number> | undefined): string {
  return vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

/**
 * One dictionary key, resolved in a given language with its placeholders filled in.
 *
 * A plural entry's form is picked by `Intl.PluralRules` on `vars.count`, which is then also
 * substituted for `{count}` in whichever template that selects, so a caller passes one number
 * and never branches on a language's own plural rule by hand.
 *
 * Exported for ./day.ts and ./stats.ts, the plain functions that already take an explicit
 * `Locale` for the Intl calls they make: passing the same one here keeps them pure and testable
 * without touching the active language below, which is the whole reason those files exist
 * separately from the screens that render them. Every component instead calls `t` or `useT`.
 */
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

/** `translate`, against whichever language is active right now. What every component calls. */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate(active, key, vars);
}

/**
 * `t`, bound to a re-render when the language changes. Every component translating text calls
 * this rather than the bare function above, so a language change reaches it without anybody
 * having to remember to subscribe by hand.
 */
export function useT(): typeof t {
  useLocale();

  return t;
}

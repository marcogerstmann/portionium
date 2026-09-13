import { afterEach, describe, expect, it } from 'vitest';

import { getLocale, setLocale, t } from './i18n';
import { de } from './locales/de';
import { en } from './locales/en';

/**
 * The parity check POR-64 asks for, plus the small amount of real logic in ./i18n.ts: picking a
 * plural form and filling in a placeholder. The dictionaries' own words are not asserted here,
 * that is a translation review's job and not a test's.
 */

afterEach(() => {
  // Every test below chooses a language explicitly, so none of them should leak into the next,
  // whatever the environment the suite happens to run in offered as a default.
  setLocale(null);
});

describe('the two dictionaries', () => {
  it('carry exactly the same keys, so a half translated release fails here rather than on screen', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it('agree on which keys are plural, so a form nobody wrote is never silently `other`', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const isPlural = (value: unknown) => typeof value === 'object';
      expect(isPlural(de[key])).toBe(isPlural(en[key]));
    }
  });
});

describe('t', () => {
  it('fills in a placeholder from the vars it is given', () => {
    setLocale('en-US');
    expect(t('todaySignOut', { name: 'Ada' })).toBe('Sign out, Ada');
  });

  it('reads the active language, not a fixed one', () => {
    setLocale('de');
    expect(t('todaySave')).toBe('Speichern');
    setLocale('en-US');
    expect(t('todaySave')).toBe('Save');
  });

  it('picks a plural form with Intl.PluralRules and substitutes the count into it', () => {
    setLocale('en-US');
    expect(t('statsReadings', { count: 1 })).toBe('1 reading');
    expect(t('statsReadings', { count: 5 })).toBe('5 readings');

    setLocale('de');
    expect(t('statsReadings', { count: 1 })).toBe('1 Messung');
    expect(t('statsReadings', { count: 5 })).toBe('5 Messungen');
  });
});

describe('setLocale', () => {
  it('does nothing on a runtime with no navigator until asked, then follows the choice', () => {
    setLocale('de');
    expect(getLocale()).toBe('de');
  });

  it('null goes back to following the browser rather than staying pinned', () => {
    setLocale('de');
    setLocale(null);
    // No navigator in this test environment, see ./i18n.ts's browserLocale, so the fallback is
    // the same one a browser with no supported language would get.
    expect(getLocale()).toBe('en-US');
  });
});

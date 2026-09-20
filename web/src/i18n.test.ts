import { afterEach, describe, expect, it } from 'vitest';

import { getLocale, setLocale, t } from './i18n';
import { de } from './locales/de';
import { en } from './locales/en';

afterEach(() => {
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
    expect(t('composeAdding', { name: 'Ada' })).toBe('Adding Ada');
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
    expect(getLocale()).toBe('en-US');
  });
});

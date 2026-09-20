import type { Category, Locale } from '@portionium/schemas';

import { t, translate, type TranslationKey } from './i18n';

export const UNCLASSIFIED = 'unclassified';

export type DotCategory = Category | typeof UNCLASSIFIED;

/**
 * Literal classes rather than `bg-${category}`: Tailwind finds class names by scanning the source.
 */
export const DOTS: Record<DotCategory, { fill: string }> = {
  green: { fill: 'bg-green' },
  yellow: { fill: 'bg-yellow' },
  orange: { fill: 'bg-orange' },
  [UNCLASSIFIED]: { fill: 'bg-unclassified' },
};

const CATEGORY_KEYS: Record<DotCategory, TranslationKey> = {
  green: 'categoryGreen',
  yellow: 'categoryYellow',
  orange: 'categoryOrange',
  [UNCLASSIFIED]: 'categoryUnclassified',
};

export function categoryLabel(category: DotCategory): string {
  return t(CATEGORY_KEYS[category]);
}

export function categoryLabelIn(category: DotCategory, locale: Locale): string {
  return translate(locale, CATEGORY_KEYS[category]);
}

export function dotOf(category: Category | null): DotCategory {
  return category ?? UNCLASSIFIED;
}

/**
 * Hue alone separates these on screen, so the label is the only channel a colour blind reader has.
 */
export function Dot({
  category,
  pending = false,
  silent = false,
}: {
  category: DotCategory;
  pending?: boolean;
  silent?: boolean;
}) {
  const { fill } = DOTS[category];
  const label = categoryLabel(category);

  return (
    <span
      {...(silent
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': pending ? t('dotPending', { label }) : label })}
      className={`inline-block size-5.5 shrink-0 rounded-full ${fill}${
        pending ? ' border-2 border-muted' : ''
      }`}
    />
  );
}

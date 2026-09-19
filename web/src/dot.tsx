import type { Category, Locale } from '@portionium/schemas';

import { t, translate, type TranslationKey } from './i18n';

/**
 * The traffic light, as a component, because it is the one thing this product says and three
 * screens now say it. Its own module rather than an export from ./today.tsx so that the
 * composer and the statistics screen can use it without the screens importing each other.
 */

/** No colour yet. A fourth visual state rather than a missing one, see Dot. */
export const UNCLASSIFIED = 'unclassified';

export type DotCategory = Category | typeof UNCLASSIFIED;

/**
 * How each colour is filled.
 *
 * A literal class rather than `bg-${category}`, because Tailwind finds class names by scanning
 * this file as text and an interpolated one produces no CSS at all.
 */
export const DOTS: Record<DotCategory, { fill: string }> = {
  green: { fill: 'bg-green' },
  yellow: { fill: 'bg-yellow' },
  orange: { fill: 'bg-orange' },
  [UNCLASSIFIED]: { fill: 'bg-unclassified' },
};

/** Translated via ./i18n.ts, so a new category is a compile error in both this and the dictionaries. */
const CATEGORY_KEYS: Record<DotCategory, TranslationKey> = {
  green: 'categoryGreen',
  yellow: 'categoryYellow',
  orange: 'categoryOrange',
  [UNCLASSIFIED]: 'categoryUnclassified',
};

/**
 * What each colour is called, in the active language.
 *
 * This is what a screen reader announces and the channel that does not depend on seeing
 * anything at all. It is now also the only channel besides the colour: the letter that used to
 * sit inside the disc is gone on POR-63, and the shape that briefly replaced it was dropped
 * deliberately, so every dot is a point and hue alone separates the four on screen. That is a
 * known deviation from this story's own greyscale criterion, and the thing to restore if it ever
 * needs restoring is a second channel here rather than a second component somewhere else.
 */
export function categoryLabel(category: DotCategory): string {
  return t(CATEGORY_KEYS[category]);
}

/**
 * The same name, in a language handed to it rather than the active one, so the plain functions
 * that already take an explicit `Locale` can say a colour out loud without reaching for the
 * active language. The same split `translate` is to `t`, and the reason ./budget.ts can stay a
 * set of pure functions. One map behind both, so the two can never disagree about a word.
 */
export function categoryLabelIn(category: DotCategory, locale: Locale): string {
  return translate(locale, CATEGORY_KEYS[category]);
}

/** A colour as a dot takes it: null on the wire is a state, not a missing value. */
export function dotOf(category: Category | null): DotCategory {
  return category ?? UNCLASSIFIED;
}

/**
 * One traffic light, as a coloured point.
 *
 * `role="img"` with a label rather than an empty element, so a screen reader announces "green"
 * once rather than finding nothing here at all.
 *
 * `pending` is the unsent state, and it is drawn as a ring rather than by dimming the dot. A
 * dimmed colour is a worse colour, which on this screen is a different meaning; a ring is a mark
 * beside the meaning rather than a change to it. It is a border inside the dot rather than an
 * outline around it, so a queued meal takes exactly the width of a sent one and two rings a gap
 * apart cannot reach across it and read as a chain. It is announced too: a screen reader has no
 * way to hear that something looks faint.
 *
 * `silent` is for a dot inside something that already names itself, a search result whose row
 * says "Skyr, green". Announcing the colour again there would read the row twice.
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

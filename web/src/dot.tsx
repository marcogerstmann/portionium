import type { Category } from '@portionium/schemas';

/**
 * The traffic light, as a component, because it is the one thing this product says and two
 * screens now say it. Its own module rather than an export from ./today.tsx so that the
 * composer can use it without the two screens importing each other.
 */

/** No colour yet. A fourth visual state rather than a missing one, see Dot. */
export const UNCLASSIFIED = 'unclassified';

export type DotCategory = Category | typeof UNCLASSIFIED;

/**
 * What each colour is called, and the letter that carries it when the colour cannot.
 *
 * The letter is not decoration. Around one man in twelve cannot tell this palette's green from
 * its orange, and a screen whose only signal is hue is a screen those people cannot read, so
 * every dot says which it is in a second channel that survives any kind of colour vision. The
 * `aria-label` is the third channel, for a person who is not looking at it at all.
 */
export const DOTS: Record<DotCategory, { letter: string; label: string }> = {
  green: { letter: 'G', label: 'green' },
  yellow: { letter: 'Y', label: 'yellow' },
  orange: { letter: 'O', label: 'orange' },
  [UNCLASSIFIED]: { letter: '?', label: 'not classified yet' },
};

/** A colour as a dot takes it: null on the wire is a state, not a missing value. */
export function dotOf(category: Category | null): DotCategory {
  return category ?? UNCLASSIFIED;
}

/**
 * One traffic light, as a letter in a coloured disc.
 *
 * `role="img"` with a label rather than bare text, so a screen reader announces "green" once
 * instead of spelling out a row of letters, and the letter itself is left to the eye.
 *
 * `pending` is the unsent state, and it is drawn as a ring rather than by dimming the dot. A
 * dimmed colour is a worse colour, which on this screen is a different meaning; a ring is a mark
 * beside the meaning rather than a change to it. It is announced too, for the reason the ticket
 * gives: a screen reader has no way to hear that something looks faint.
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
  const { letter, label } = DOTS[category];

  return (
    <span
      {...(silent
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': pending ? `${label}, not sent yet` : label })}
      className={`dot dot--${category}${pending ? ' dot--pending' : ''}`}
    >
      {letter}
    </span>
  );
}

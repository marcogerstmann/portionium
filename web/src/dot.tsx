import type { Category } from '@portionium/schemas';

/**
 * The traffic light, as a component, because it is the one thing this product says and three
 * screens now say it. Its own module rather than an export from ./today.tsx so that the
 * composer and the statistics screen can use it without the screens importing each other.
 */

/** No colour yet. A fourth visual state rather than a missing one, see Dot. */
export const UNCLASSIFIED = 'unclassified';

export type DotCategory = Category | typeof UNCLASSIFIED;

/**
 * What each colour is called and how it is filled.
 *
 * The label is what a screen reader announces and is the channel that does not depend on seeing
 * anything at all. It is now also the only channel besides the colour: the letter that used to
 * sit inside the disc is gone on POR-63, and the shape that briefly replaced it was dropped
 * deliberately, so every dot is a point and hue alone separates the four on screen. That is a
 * known deviation from this story's own greyscale criterion, and the thing to restore if it ever
 * needs restoring is a second channel here rather than a second component somewhere else.
 *
 * The fill is a literal class rather than `bg-${category}`, because Tailwind finds class names by
 * scanning this file as text and an interpolated one produces no CSS at all.
 */
export const DOTS: Record<DotCategory, { fill: string; label: string }> = {
  green: { fill: 'bg-green', label: 'green' },
  yellow: { fill: 'bg-yellow', label: 'yellow' },
  orange: { fill: 'bg-orange', label: 'orange' },
  [UNCLASSIFIED]: { fill: 'bg-unclassified', label: 'not classified yet' },
};

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
  const { fill, label } = DOTS[category];

  return (
    <span
      {...(silent
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': pending ? `${label}, not sent yet` : label })}
      className={`inline-block size-5.5 shrink-0 rounded-full ${fill}${
        pending ? ' border-2 border-muted' : ''
      }`}
    />
  );
}

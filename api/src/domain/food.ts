/**
 * What makes two catalog entries the same entry.
 *
 * The catalog is shared and everybody adds to it while halfway through logging a meal, so the
 * failure mode is not a wrong entry, it is four almost identical ones. "Skyr", "skyr" and
 * "Skyr " are one food that three people typed, and a catalog that holds all three splits a
 * user's own history across them and asks the classifier the same question three times.
 */

/**
 * The form a name is compared in, never the form it is stored in. What somebody typed is what
 * the catalog shows, capitals and all, because "Skyr" is the name of the thing and "skyr" is
 * an artefact of matching it.
 *
 * Case folding happens in JavaScript rather than in SQL. SQLite's own `lower()` is ASCII only
 * unless it is built with ICU, so `MÜSLI` and `Müsli` would be two foods on the exact vowels
 * this catalog is full of.
 *
 * Accents are deliberately left alone. Folding them would make `Muesli` and `Müsli` one entry,
 * and in German those are the same word, but the same rule elsewhere merges foods that are not
 * the same thing at all. A near miss that creates a duplicate is cheap; a match that merges two
 * different foods puts the wrong colour on somebody's plate.
 */
export function normalizeFoodName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

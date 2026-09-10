import { normalizeFoodName } from './food.js';

/**
 * What "finding Skyr" means, stated once and away from SQL.
 *
 * Recall and ranking are deliberately different jobs in different places. SQLite's FTS5 index
 * answers "which entries contain this run of characters", which is the part that has to stay
 * fast as the catalog grows, and everything in this file answers "and which of them did you
 * mean", which is a handful of comparisons over the few rows that came back.
 *
 * Ranking lives here rather than in the query for the same reason resolveClassification does:
 * it is a product decision, it is the kind of rule that gets a second implementation written
 * for speed, and two implementations of an ordering are two different answers to the same
 * search box.
 */

/**
 * The shortest query the trigram index can answer at all.
 *
 * FTS5's trigram tokenizer indexes overlapping runs of three characters, so a query of one or
 * two returns nothing rather than everything. That is not a bug to work around in SQL, it is
 * the reason a query this short is answered by a prefix scan instead, see looselyMatches.
 */
export const TRIGRAM_MIN_LENGTH = 3;

/**
 * The query as an FTS5 MATCH expression, or undefined when the index cannot answer it.
 *
 * One quoted phrase rather than a bare string, for two reasons. A bare query is parsed as FTS5
 * syntax, so a user typing `AND`, `*` or a stray quote gets a SQL error instead of results.
 * And the trigram tokenizer matches a phrase as a contiguous run, which is what makes `kyr`
 * find `Skyr` and `nut but` find `Peanut Butter`.
 *
 * Doubling the quote is FTS5's own escape, the same rule SQL string literals follow.
 */
export function toFtsMatch(query: string): string | undefined {
  const target = normalizeFoodName(query);
  if (target.length < TRIGRAM_MIN_LENGTH) {
    return undefined;
  }

  return `"${target.replaceAll('"', '""')}"`;
}

/**
 * Whether one string becomes the other with a single insertion, deletion, substitution or
 * transposition of adjacent characters. Damerau-Levenshtein, asked as a yes or no.
 *
 * A yes or no rather than a distance, because a budget of one turns the usual quadratic table
 * into a single walk of both strings: the first mismatch is spent, and everything after it has
 * to line up exactly. That is what makes it cheap enough to ask about every name in the catalog.
 *
 * The transposition case is why this is Damerau rather than plain Levenshtein, and it is not
 * decoration. `Sykr` for `Skyr` is the typo people actually make, and it shares no trigram at
 * all with its target, so it is precisely the one the index behind this cannot find.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }

  const lengthDifference = a.length - b.length;
  if (lengthDifference > 1 || lengthDifference < -1) {
    return false;
  }

  let i = 0;
  let j = 0;
  let budget = 1;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }

    if (budget-- === 0) {
      return false;
    }

    if (lengthDifference === 0) {
      // Two characters that swapped places, or one that is simply wrong. Either way the walk
      // continues past them, and a second mismatch is what fails.
      if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
        i += 2;
        j += 2;
      } else {
        i += 1;
        j += 1;
      }
    } else if (lengthDifference === 1) {
      i += 1;
    } else {
      j += 1;
    }
  }

  // Whatever is left over is at most the one character the lengths already differ by, and the
  // walk only reaches here with the budget unspent in that case.
  return true;
}

/**
 * Whether a name is worth showing for a query that the trigram index could not answer well.
 *
 * Two jobs, and neither of them is substring matching, which is the index's. A prefix, so
 * `sk` finds `Skyr` before three characters have been typed, on the whole name and on each
 * word so that `but` finds `Peanut Butter`. And a single typo, on the same two.
 *
 * Typo tolerance is withheld below three characters on purpose. Every two letter string is
 * within one edit of a great many others, so applying it there turns an autocomplete into a
 * list of the entire catalog in an arbitrary order.
 */
export function looselyMatches(name: string, query: string): boolean {
  const target = normalizeFoodName(query);
  if (target === '') {
    return false;
  }

  const normalized = normalizeFoodName(name);
  const words = normalized.split(' ');

  if (normalized.startsWith(target) || words.some((word) => word.startsWith(target))) {
    return true;
  }

  if (target.length < TRIGRAM_MIN_LENGTH) {
    return false;
  }

  return withinOneEdit(normalized, target) || words.some((word) => withinOneEdit(word, target));
}

/**
 * How well a name matches, once whether it matches has been settled. Lower is better, and the
 * order is the one a person reading a dropdown expects: what they are typing the start of,
 * then what they are typing a word of, then what merely contains it, then what needed a typo
 * forgiven to get here at all.
 */
function lexicalRank(normalizedName: string, target: string): number {
  if (normalizedName.startsWith(target)) {
    return 0;
  }
  if (normalizedName.split(' ').some((word) => word.startsWith(target))) {
    return 1;
  }
  if (normalizedName.includes(target)) {
    return 2;
  }

  return 3;
}

/**
 * What ranking needs to know about a candidate, which is deliberately less than a food row.
 * `lastUsedAt` is the caller's own most recent meal naming it, `uses` is how often anybody has
 * eaten it. Both are null and zero for an entry nobody has logged.
 */
export interface SearchCandidate {
  name: string;
  lastUsedAt: Date | null;
  uses: number;
}

/**
 * The order results come back in, newest key first:
 *
 *   1. an exact match, because somebody who typed the whole name meant that entry
 *   2. the caller's own most recently eaten foods
 *   3. how often the food is eaten across the instance
 *   4. lexical relevance, then the shorter name, then alphabetically
 *
 * The second key is the one that makes this feel fast rather than merely correct. Most of
 * anyone's diet is the same twenty foods, so a personal history is a far better predictor of
 * what somebody is typing than any property of the catalog is.
 *
 * The last two keys never decide anything a human would notice. They are there so that two
 * entries nobody has eaten come back in the same order on every machine and in every run,
 * which is what stops a dropdown reshuffling itself between keystrokes.
 */
export function rankSearchResults<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
): T[] {
  const target = normalizeFoodName(query);

  return candidates
    .map((candidate) => ({ candidate, normalized: normalizeFoodName(candidate.name) }))
    .sort((a, b) => {
      const exact = Number(b.normalized === target) - Number(a.normalized === target);
      const recency =
        (b.candidate.lastUsedAt?.getTime() ?? -1) - (a.candidate.lastUsedAt?.getTime() ?? -1);

      return (
        exact ||
        recency ||
        b.candidate.uses - a.candidate.uses ||
        lexicalRank(a.normalized, target) - lexicalRank(b.normalized, target) ||
        a.normalized.length - b.normalized.length ||
        (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0)
      );
    })
    .map(({ candidate }) => candidate);
}

import { normalizeFoodName } from './food.js';

/**
 * FTS5's trigram tokenizer indexes runs of three characters, so a shorter query matches nothing at
 * all.
 */
export const TRIGRAM_MIN_LENGTH = 3;

/**
 * Quoted as a phrase: a bare query is parsed as FTS5 syntax, so `AND`, `*` or a stray quote is a
 * SQL error rather than a search.
 */
export function toFtsMatch(query: string): string | undefined {
  const target = normalizeFoodName(query);
  if (target.length < TRIGRAM_MIN_LENGTH) {
    return undefined;
  }

  return `"${target.replaceAll('"', '""')}"`;
}

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

  return true;
}

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

export interface SearchCandidate {
  name: string;
  lastUsedAt: Date | null;
  uses: number;
}

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

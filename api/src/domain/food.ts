/**
 * Case folding happens here rather than in SQL, which SQLite without ICU cannot do for non-ASCII.
 */
export function normalizeFoodName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

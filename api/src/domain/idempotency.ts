import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort())
      : item,
  );
}

export function fingerprintRequest(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(url)
    .update('\n')
    .update(canonicalize(body ?? null))
    .digest('hex');
}

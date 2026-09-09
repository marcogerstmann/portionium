import { createHash } from 'node:crypto';

/**
 * What makes two requests the same request, with no database and no HTTP in sight.
 *
 * A client retrying from an outbox sends the same key twice. Whether the second one may be
 * answered from the first one's stored response depends on whether it is asking for the same
 * thing, and that is decided here by hashing what it asked for. The row and the hooks are in
 * db/idempotency.ts and http/plugins/idempotency.ts, and the reasoning is
 * docs/adr/004-idempotency-keys.md.
 */

/**
 * JSON with every object's keys in sorted order, at every depth, so two serialisations of the
 * same value hash the same whatever order a client happened to write its properties in. Arrays
 * keep their order, because order is part of what an array means.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort())
      : item,
  );
}

/**
 * SHA-256 over the method, the URL as requested, and the canonical body. A key reused for a
 * different method, a different path or a different payload is a client bug, and the
 * fingerprint is what turns that into a 422 rather than a wrong stored answer.
 *
 * The body is the parsed and validated one, so a request that Zod has already normalised
 * fingerprints the same as its normalised form. `undefined` for a method that carries none.
 */
export function fingerprintRequest(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(url)
    .update('\n')
    .update(canonicalize(body ?? null))
    .digest('hex');
}

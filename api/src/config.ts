import { z } from 'zod';

/**
 * Every environment variable the API reads. Keep .env.example in step with this schema,
 * it is the documented contract for anyone running the app.
 */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/portionium.db'),
  /**
   * Serves the Swagger UI at /api/v1/docs. The generated spec at /api/v1/openapi.json is
   * always served, it is the contract clients are built from. Only the browsable UI, which
   * ships a few hundred kilobytes of assets and invites poking at a production API, is
   * behind a switch.
   */
  API_DOCS_ENABLED: z.stringbool().default(true),
  /**
   * The single origin the web client is served from, scheme and host and port, no trailing
   * slash. Two things read it.
   *
   * It is the CSRF check: a mutating request that arrives on a session cookie must carry an
   * `Origin` header equal to this, and one with a foreign origin or none at all is refused. A
   * browser sets that header itself and a page cannot forge it, which is what makes it the one
   * signal worth checking, unlike the cookie, which a browser attaches to a cross site request
   * as willingly as to a first party one.
   *
   * Its scheme also decides whether the session cookie is marked `Secure`, so a developer on
   * plain http gets a cookie their browser will actually store, and anything deployed over
   * https gets one that never crosses a plain connection. Deriving it beats a second variable
   * that can be set to the wrong half of the pair.
   */
  WEB_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .default('http://localhost:5173')
    // Normalised to what a browser actually puts in the header, so a value configured with a
    // trailing slash or a default port spelled out does not silently refuse every request.
    .transform((value) => new URL(value).origin),
  /**
   * How long a session survives without being used. Refreshed on activity, so this is an
   * idle timeout rather than a lifetime, and a person using the app daily is never signed out.
   */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /**
   * How long a stored `Idempotency-Key` answers a retry before the key may be reused. Long
   * enough to outlive any outbox retry a phone will make, short enough that the table stays
   * small. Why 24 is docs/adr/004-idempotency-keys.md.
   */
  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /**
   * Requests a single caller may make per minute, counted per credential and per address, in
   * three buckets because the three cost the server wildly different things. A read is a query
   * against a file already in the page cache, a write is a transaction and an fsync, and a sign
   * in is an Argon2id verification at 19 MiB, which is the most expensive thing this process
   * does and therefore the most attractive thing to point a flood at.
   *
   * The defaults are generous for a person and mean for a script: nothing a human does with the
   * web app comes close to two reads a second sustained for a minute. Where the counters live,
   * and why not Redis, is docs/adr/005-no-redis-no-metrics-stack.md.
   */
  RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /**
   * How far a weight reading may sit from the nearest one on record, as a fraction of that one
   * per day between them, before POST /weight flags it as a warning. Never blocks the write,
   * see createWeightEntry in api/src/domain/weight.ts. The general adult population default is
   * two percent; a clinical deployment tracking faster real change wants this wider.
   */
  WEIGHT_MAX_DRIFT_PER_DAY: z.coerce.number().min(0).max(1).default(0.02),
  /**
   * Largest request body accepted, in bytes. Anything above it is refused with 413 before the
   * body is read into memory, which is what makes it a limit rather than a check.
   *
   * A megabyte is Fastify's own default and roughly two orders of magnitude more than the
   * largest thing this API takes, a meal with a long list of items. It is written down here
   * rather than left implicit so that the day something wants to accept a photograph, raising
   * it is a decision somebody makes on purpose.
   */
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  /**
   * Origins allowed to call this API from a browser they were not served by. Empty by default,
   * so no CORS headers are sent at all and only the origin this API is served alongside can
   * read a response.
   *
   * A comma separated list of exact origins. There is no wildcard and there is no pattern:
   * every response here is credentialed, so `*` is both refused by the specification and the
   * wrong answer for a personal food diary.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    )
    .pipe(
      z
        .array(z.url({ protocol: /^https?$/ }))
        .transform((origins) => origins.map((origin) => new URL(origin).origin)),
    ),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Validates the process environment. Throws with a readable, multi line message listing
 * every problem at once, rather than failing on the first one and hiding the rest.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Invalid environment configuration:\n${problems}\n\nSee .env.example for the expected values.`,
  );
}

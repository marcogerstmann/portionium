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

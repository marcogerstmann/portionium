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
   * Directory holding the built web client, which this process then serves on its own origin
   * with a fallback to the app shell for the client's own routes. See http/plugins/static.ts.
   *
   * Empty by default and therefore off, which is right for every test and for development,
   * where the client runs on the Vite dev server and proxies /api here. The container sets it,
   * because one process serving both halves is what lets the application ship as one image and
   * is what makes the same origin true rather than merely configured.
   */
  WEB_ROOT: z.string().default(''),
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
   * How long it takes a weight reading to lose half its influence on the smoothed trend, in
   * days. Ten keeps a fortnight of real change visible while a single heavy dinner moves the
   * line by grams. Lower tracks the scale more closely and reports more noise as progress;
   * higher is calmer and lags further behind. Why ten, and what it costs, is
   * docs/adr/008-weight-trend-smoothing.md.
   */
  WEIGHT_TREND_HALF_LIFE_DAYS: z.coerce.number().min(1).max(60).default(10),
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
  /**
   * The credential for the model that classifies a food nobody in the catalog recognises.
   *
   * Optional, and empty by default, because the catalog answers almost everything and an
   * instance that never reaches the classifier is the behaviour this project claims rather
   * than a degraded one. Absent means that path is off and the startup log says so, see
   * index.ts, which is the difference between a feature somebody chose not to configure and
   * one that is broken.
   *
   * It is the first secret this process reads, and it is why SECRET_KEY_PATTERN below exists
   * rather than being added the day it was needed.
   */
  AI_API_KEY: z.string().default(''),
});

/**
 * Hosts where plain http is somebody's deliberate local choice rather than a credential on an
 * untrusted wire: loopback, the private and link local IPv4 ranges, the suffixes a home network
 * resolves on its own, and anything without a dot in it, which covers a bare hostname and an
 * IPv6 literal in brackets and cannot be a public name either way.
 *
 * ponytail: the ranges written out rather than a CIDR library, they have not moved since 1996.
 * A deployment on something exotic, a CGNAT range on a mesh VPN say, sets https or an override
 * we have not needed yet.
 */
const PRIVATE_HOST = new RegExp(
  [
    '^[^.]+$',
    '^127\\.',
    '^10\\.',
    '^192\\.168\\.',
    '^172\\.(1[6-9]|2\\d|3[01])\\.',
    '^169\\.254\\.',
    '\\.(local|internal|lan|home\\.arpa)$',
  ].join('|'),
  'i',
);

/**
 * The one configuration that can weaken a session credential, refused in production.
 *
 * There is no session secret to check here and there never will be: a session token is 32 bytes
 * from a CSPRNG, stored as a SHA-256 of itself, so there is no key shared between sessions that
 * could be left at a default or set to something guessable. See domain/auth.ts.
 *
 * What is left is the scheme of WEB_ORIGIN, because the session cookie's `Secure` flag follows
 * it, see http/plugins/auth.ts. Plain http against a public host in production is therefore an
 * `HttpOnly` cookie travelling in clear across whatever is between the browser and the server,
 * which is the modern shape of the mistake the weak secret check was invented for, and the
 * process refuses to start on it rather than serving an instance whose sessions can be read off
 * a shared network.
 *
 * Loopback and private addresses are allowed and deliberately so. The image ships
 * WEB_ORIGIN=http://localhost:8080 so that `docker run` with no environment at all is a working
 * instance, and the deployment this project is actually for is a machine on a home network. A
 * check that refused those would be a check somebody switches off.
 */
const productionOrigin = configSchema.superRefine((config, ctx) => {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  const { protocol, hostname } = new URL(config.WEB_ORIGIN);
  if (protocol === 'http:' && !PRIVATE_HOST.test(hostname)) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEB_ORIGIN'],
      message:
        `${config.WEB_ORIGIN} is plain http against a public host in production. The session ` +
        'cookie is marked Secure only when this is https, so every sign in would cross the ' +
        'network in clear. Serve it over https, the caddy profile in docker-compose.yml does ' +
        'that on its own, or name the private address if this instance is only reachable on a ' +
        'local network.',
    });
  }
});

export type Config = z.infer<typeof configSchema>;

/**
 * Config keys whose value is a secret and must never be logged. Matched on the name rather than
 * listed, which is why AI_API_KEY arrived masked without anybody editing this line, and why the
 * next credential will too.
 */
const SECRET_KEY_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/;

/**
 * The resolved configuration, ready to log. Startup writes this, because the commonest
 * deployment failure is an environment variable that is not what somebody thinks it is, and a
 * default that quietly applied is invisible in the environment it came from.
 */
export function maskedConfig(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : value,
    ]),
  );
}

/**
 * Validates the process environment. Throws with a readable, multi line message listing
 * every problem at once, rather than failing on the first one and hiding the rest.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = productionOrigin.safeParse(env);
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

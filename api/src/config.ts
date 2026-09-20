import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/portionium.db'),
  API_DOCS_ENABLED: z.stringbool().default(true),
  WEB_ROOT: z.string().default(''),
  WEB_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .default('http://localhost:5173')
    // Normalised to what a browser actually sends, so a trailing slash or an explicit default port
    // does not refuse every request.
    .transform((value) => new URL(value).origin),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  WEIGHT_MAX_DRIFT_PER_DAY: z.coerce.number().min(0).max(1).default(0.02),
  WEIGHT_TREND_HALF_LIFE_DAYS: z.coerce.number().min(1).max(60).default(10),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
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
  BACKUP_DIR: z.string().default(''),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  BACKUP_KEEP_DAILY: z.coerce.number().int().min(1).max(365).default(7),
  BACKUP_KEEP_WEEKLY: z.coerce.number().int().min(0).max(52).default(4),
  BACKUP_KEEP_MONTHLY: z.coerce.number().int().min(0).max(24).default(3),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://api.openai.com/v1'),
});

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

const SECRET_KEY_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/;

export function maskedConfig(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : value,
    ]),
  );
}

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

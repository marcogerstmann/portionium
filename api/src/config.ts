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

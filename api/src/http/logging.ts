import type { FastifyServerOptions } from 'fastify';

import type { Config } from '../config.js';
import { maskEmail } from '../domain/auth.js';

/**
 * How a log line is shaped, decided here once.
 *
 * Fastify's logger is Pino, so structured JSON at a configurable level is what this process
 * already writes and there is nothing to add for it. What is added here is the half Pino
 * cannot guess: which fields must never reach a log file, and what a finished request says
 * about itself.
 *
 * Redaction lives in the logger rather than at the call sites. A rule applied where the line
 * is written is a rule every line already follows, including the ones nobody has written yet,
 * which is the difference between a convention and a guarantee. The observability half of
 * docs/adr/005-no-redis-no-metrics-stack.md is the why.
 */

/**
 * Fields a log line may never carry in full, as Pino redaction paths.
 *
 * Both a bare key and `*.<key>` one level in, because a line is written either as
 * `{ password }` or as `{ body: { password } }` and the two spellings are equally likely. A
 * path that matches nothing costs nothing, which is why the header paths are here even though
 * Fastify's own request serializer logs no headers at all: the day somebody logs `{ req }`
 * with a serializer of their own, the credential is already covered.
 *
 * `prompt` is here before anything sends one. Classifying a meal means putting what somebody
 * ate into a model's context, and a prompt log is a food diary in plain text.
 */
const REDACT_PATHS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'email',
  'prompt',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.email',
  '*.prompt',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

const REDACTED = '[redacted]';

/**
 * What a redacted field is replaced with.
 *
 * An address is masked rather than dropped, because a burst of failures against one domain is
 * the shape worth noticing in a log and the local part is the half that records who holds an
 * account here. `maskEmail` on an already masked address returns it unchanged, so a call site
 * that masks deliberately is not punished for it. See the login failure log in routes/auth.ts.
 */
function censor(value: unknown, path: string[]): unknown {
  if (path.at(-1) === 'email' && typeof value === 'string') {
    return maskEmail(value);
  }

  return REDACTED;
}

/**
 * Pino options for this process. One argument, because the level is the only part an operator
 * configures and the rest is not a knob.
 *
 * The `res` serializer is Fastify's own plus the method and the path. Out of the box a finished
 * request logs its status and duration and nothing else, so answering "what was slow at 14:32"
 * means finding the line, reading its request id and grepping backwards for the line that
 * carried the URL. Repeating two fields makes the record that actually gets grepped, the one
 * with the status on it, complete by itself.
 */
export function loggerOptions(
  level: Config['LOG_LEVEL'],
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor },
    serializers: {
      // Typed by the fields it reads rather than by Fastify's reply. Pino is handed a
      // `Partial<FastifyReply>`, so the request is optional in the type and always there in
      // practice, and annotating the full reply instead would be a wider claim than Fastify
      // makes.
      res: (reply: { statusCode: number; request?: { method: string; url: string } }) => ({
        statusCode: reply.statusCode,
        method: reply.request?.method,
        url: reply.request?.url,
      }),
    },
  };
}

import type { FastifyServerOptions } from 'fastify';

import type { Config } from '../config.js';
import { maskEmail } from '../domain/auth.js';

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

function censor(value: unknown, path: string[]): unknown {
  if (path.at(-1) === 'email' && typeof value === 'string') {
    return maskEmail(value);
  }

  return REDACTED;
}

export function loggerOptions(
  level: Config['LOG_LEVEL'],
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor },
    serializers: {
      res: (reply: { statusCode: number; request?: { method: string; url: string } }) => ({
        statusCode: reply.statusCode,
        method: reply.request?.method,
        url: reply.request?.url,
      }),
    },
  };
}

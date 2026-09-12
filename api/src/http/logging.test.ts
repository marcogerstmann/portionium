import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { loggerOptions } from './logging.js';

/**
 * Redaction and the request line, through a real Fastify logger writing to a stream this test
 * can read. Not by inspecting the path list: a list is only worth something if fast-redact
 * actually matches on it, and a path spelled slightly wrong matches nothing and fails silently,
 * which is the one way this could be wrong in production while looking right in a diff.
 */

/** Collects whatever the logger writes, as parsed lines. */
function capture() {
  const lines: Record<string, unknown>[] = [];

  const app = Fastify({
    logger: {
      ...(loggerOptions('info') as object),
      stream: {
        write: (chunk: string) => {
          lines.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    },
  });

  return { app, lines };
}

/** Logs one object through that logger and gives back what was written. */
function logged(line: Record<string, unknown>): Record<string, unknown> {
  const { app, lines } = capture();
  app.log.info(line, 'test');

  return lines[0] ?? {};
}

describe('redaction', () => {
  it('replaces a credential at the top level and one level in', () => {
    expect(
      logged({
        password: 'correct horse battery staple',
        currentPassword: 'old one',
        newPassword: 'new one',
        token: 'prt_live_abcdef',
        body: { password: 'nested', token: 'prt_nested' },
      }),
    ).toMatchObject({
      password: '[redacted]',
      currentPassword: '[redacted]',
      newPassword: '[redacted]',
      token: '[redacted]',
      body: { password: '[redacted]', token: '[redacted]' },
    });
  });

  it('drops a prompt, which is a food diary in plain text', () => {
    expect(logged({ prompt: 'classify: two slices of rye bread' }).prompt).toBe('[redacted]');
  });

  it('masks an address rather than dropping it, so a pattern of attempts stays visible', () => {
    expect(logged({ email: 'ada@example.com' }).email).toBe('a***@example.com');
    expect(logged({ user: { email: 'ada@example.com' } })).toMatchObject({
      user: { email: 'a***@example.com' },
    });
  });

  it('leaves an already masked address alone, so masking at the call site is not punished', () => {
    expect(logged({ email: 'a***@example.com' }).email).toBe('a***@example.com');
  });

  it('does not touch a field that merely looks like one of them', () => {
    expect(logged({ tokenId: 'abc', userId: 'u1', foodName: 'Skyr' })).toMatchObject({
      tokenId: 'abc',
      userId: 'u1',
      foodName: 'Skyr',
    });
  });
});

describe('what a request writes', () => {
  /**
   * The five fields the story asks for, and the point of the `res` serializer: Fastify logs the
   * status and the duration on one line and the URL on another, so without it the line somebody
   * greps for, the one carrying the status, does not say what it was a response to.
   */
  it('carries the method, path, status, duration and request id on the finished line', async () => {
    const { app, lines } = capture();
    app.get('/thing', () => ({ ok: true }));

    const response = await app.inject({ url: '/thing?q=rye' });
    await app.close();

    expect(response.statusCode).toBe(200);

    const completed = lines.find((line) => line.msg === 'request completed');
    expect(completed?.res).toEqual({ statusCode: 200, method: 'GET', url: '/thing?q=rye' });
    expect(completed?.responseTime).toBeTypeOf('number');
    expect(completed?.reqId).toBeTypeOf('string');
  });

  it('ties every line of one request to the same id, the one the client is given', async () => {
    const { app, lines } = capture();
    app.get('/thing', (request) => {
      request.log.info('something happened while serving');
      return { ok: true };
    });

    await app.inject({ url: '/thing' });
    await app.close();

    const ids = new Set(lines.filter((line) => line.reqId !== undefined).map((line) => line.reqId));

    expect(lines.map((line) => line.msg)).toContain('something happened while serving');
    expect(ids.size).toBe(1);
  });

  /**
   * Fastify's own request serializer logs no headers at all, which is what keeps the session
   * cookie and the bearer token out of the log. Asserted rather than assumed, because it is a
   * default somebody could replace with a serializer of their own.
   */
  it('logs no headers, so a credential never reaches a log file by accident', async () => {
    const { app, lines } = capture();
    app.get('/thing', () => ({ ok: true }));

    await app.inject({
      url: '/thing',
      headers: { authorization: 'Bearer prt_live_secret', cookie: 'portionium_session=secret' },
    });
    await app.close();

    expect(JSON.stringify(lines)).not.toContain('secret');
  });
});

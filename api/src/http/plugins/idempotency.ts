import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Db } from '../../db/client.js';
import {
  claimIdempotencyKey,
  findIdempotencyKey,
  purgeIdempotencyKeys,
  releaseIdempotencyKey,
  storeIdempotencyResponse,
} from '../../db/idempotency.js';
import {
  IdempotencyKeyMismatchError,
  IdempotencyRequestInProgressError,
} from '../../domain/errors.js';
import { fingerprintRequest } from '../../domain/idempotency.js';

/**
 * A retried write is answered once. The reasoning is docs/adr/004-idempotency-keys.md.
 *
 * The web client logs meals over a phone connection and retries from an outbox, so a request
 * that timed out after the server had already committed it will be sent again. Without this,
 * that retry is a second meal. With it, a client that sends the same `Idempotency-Key` on both
 * attempts gets the first attempt's response back on the second, byte for byte, and nothing
 * runs twice.
 *
 * Two hooks on the root instance, so every route gets it and no route can opt out:
 *
 *   preHandler claims the key. The body has been parsed and validated by then, which is what
 *   the fingerprint needs. A claim that the unique index refuses means the key has been seen:
 *   the stored answer is replayed if the fingerprint matches, a 422 if it does not, and a 409
 *   if the first request is still running. That last one is the whole of the concurrency
 *   story. Two copies of one request arriving together both try the insert, the database lets
 *   exactly one through, and nothing in this process has to hold a lock.
 *
 *   onSend stores the answer, or lets go of the claim when the answer is a 500, because a
 *   retry is the one thing a client with a 500 in hand needs to be able to do.
 *
 * The key is scoped to the caller, so it only means something on a route with one. A public
 * route, which today is the login, ignores the header: there is no user to file the key under
 * and a repeated login is a second session rather than a second meal. A request with no key
 * runs every time it is sent, which is what a client that has not adopted the header gets.
 */

/** Spelled the way a client sends it. Node hands it over lowercased. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Set on a response that came from the table rather than from the handler. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * How often the purge runs. Hourly is coarse on purpose: the retention window is a day and a
 * key living an hour past it changes nothing a client can observe, except that a reused key
 * inside that hour is answered from the table rather than run again. See ADR 004.
 */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface IdempotencyPluginOptions {
  db: Db;
  /** How long a stored key answers a retry. See config.IDEMPOTENCY_RETENTION_HOURS. */
  retentionMs: number;
}

export function registerIdempotency(
  app: FastifyInstance,
  { db, retentionMs }: IdempotencyPluginOptions,
): void {
  /** The claimed row for each request that made one, so onSend knows which row to fill. */
  const claims = new WeakMap<FastifyRequest, string>();

  app.addHook('preHandler', async (request, reply) => {
    const auth = request.routeOptions.config?.auth;
    const key = request.headers['idempotency-key'];

    if (
      !MUTATING_METHODS.has(request.method) ||
      auth === undefined ||
      auth === 'public' ||
      typeof key !== 'string' ||
      key === ''
    ) {
      return;
    }

    const { userId } = request.auth;
    const fingerprint = fingerprintRequest(request.method, request.url, request.body);

    const claimed = claimIdempotencyKey(db, { userId, key, fingerprint });
    if (claimed !== undefined) {
      claims.set(request, claimed.id);
      return;
    }

    const existing = findIdempotencyKey(db, userId, key);

    // Refused a moment ago and gone now means the purge took it between the two statements.
    // Rare enough that a 409 and a retry is the right answer rather than a second claim.
    if (existing === undefined || existing.responseStatus === null) {
      throw new IdempotencyRequestInProgressError();
    }

    if (existing.fingerprint !== fingerprint) {
      request.log.warn({ userId, key }, 'idempotency key reused for a different request');
      throw new IdempotencyKeyMismatchError();
    }

    request.log.info({ userId, key }, 'idempotent replay');

    reply.code(existing.responseStatus).header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    if (existing.responseContentType !== null) {
      reply.type(existing.responseContentType);
    }

    // The stored body is already serialised, so it goes out as a string and skips the schema.
    await reply.send(existing.responseBody);
    return reply;
  });

  app.addHook('onSend', async (request, reply, payload: unknown) => {
    const id = claims.get(request);
    if (id === undefined) {
      return payload;
    }

    // A 500 says nothing about whether the write happened, and neither would its replay. The
    // claim is dropped so the client's retry runs the request again. Same for a payload that
    // is not text, which nothing here produces today and which a row cannot hold.
    if (reply.statusCode >= 500 || (payload !== null && typeof payload !== 'string')) {
      releaseIdempotencyKey(db, id);
      return payload;
    }

    const contentType = reply.getHeader('content-type');
    storeIdempotencyResponse(db, id, {
      status: reply.statusCode,
      body: payload === '' ? null : payload,
      contentType: typeof contentType === 'string' ? contentType : null,
    });

    return payload;
  });

  // The scheduled purge. unref'd so a process that is otherwise done does not stay up for it,
  // and cleared on close so a test that built an app does not leak a timer.
  const purge = setInterval(() => {
    const dropped = purgeIdempotencyKeys(db, new Date(Date.now() - retentionMs));
    if (dropped > 0) {
      app.log.info({ dropped }, 'purged expired idempotency keys');
    }
  }, PURGE_INTERVAL_MS);
  purge.unref();

  app.addHook('onClose', () => {
    clearInterval(purge);
  });
}

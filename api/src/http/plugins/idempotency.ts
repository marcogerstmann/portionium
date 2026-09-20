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

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface IdempotencyPluginOptions {
  db: Db;
  retentionMs: number;
}

export function registerIdempotency(
  app: FastifyInstance,
  { db, retentionMs }: IdempotencyPluginOptions,
): void {
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

    // Already serialised, so it goes out as a string and skips the response schema.
    await reply.send(existing.responseBody);
    return reply;
  });

  app.addHook('onSend', async (request, reply, payload: unknown) => {
    const id = claims.get(request);
    if (id === undefined) {
      return payload;
    }

    // A 500 says nothing about whether the write happened, so the claim is dropped and the client's
    // retry runs the request again.
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

  // unref'd so it does not hold the process up, cleared on close so a test does not leak it.
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

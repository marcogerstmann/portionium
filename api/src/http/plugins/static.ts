import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const APP_SHELL = 'index.html';

const HASHED_DIR = 'assets';

/**
 * Safe only because Vite puts a content hash in these filenames, so a changed file is a different
 * URL.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

const REVALIDATE = 'no-cache';

export type ServeWebApp = (request: FastifyRequest, reply: FastifyReply) => boolean;

export interface WebAppPluginOptions {
  root: string;
  apiPathPrefix: string;
}

function servableFiles(root: string): ReadonlySet<string> {
  return new Set(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map(
        (entry) => `/${relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')}`,
      ),
  );
}

export async function registerWebApp(
  app: FastifyInstance,
  { root, apiPathPrefix }: WebAppPluginOptions,
): Promise<ServeWebApp> {
  const hashedPrefix = join(root, HASHED_DIR) + sep;

  await app.register(fastifyStatic, {
    root,
    serve: false,
    cacheControl: false,
    setHeaders(reply, path) {
      reply.header('Cache-Control', path.startsWith(hashedPrefix) ? IMMUTABLE : REVALIDATE);
    },
  });

  // Read once at startup: the directory cannot change while the process runs. A path not literally
  // in this set is never handed to the sender.
  const files = servableFiles(root);

  return (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return false;
    }

    const pathname = request.url.split('?', 1)[0] ?? '/';

    if (pathname.startsWith(apiPathPrefix)) {
      return false;
    }

    if (files.has(pathname)) {
      void reply.sendFile(pathname);
      return true;
    }

    if (pathname.split('/').at(-1)?.includes('.') === true) {
      return false;
    }

    void reply.sendFile(APP_SHELL);
    return true;
  };
}

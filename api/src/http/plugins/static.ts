import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The built web client, served by the API process on the origin the API answers on.
 *
 * One origin is the point of doing it here rather than putting a second server in front. The
 * session cookie is `SameSite=Lax` and the CSRF check compares `Origin` against WEB_ORIGIN, so
 * a client served from somewhere else is a client whose writes are refused unless CORS and a
 * second origin are configured. One process serving both makes that configuration unnecessary
 * rather than merely easy, which is also what lets the whole application ship as one container.
 *
 * Nothing here is registered unless WEB_ROOT names a directory. In development the client runs
 * on the Vite dev server and proxies /api to this process, so this is a production path only.
 */

/** The one file every client route resolves to, and the only entry point the bundle has. */
const APP_SHELL = 'index.html';

/** Where Vite writes everything it content hashes, and the only place it writes those. */
const HASHED_DIR = 'assets';

/**
 * A year, which is the longest a browser will honour anyway, and `immutable` so a reload does
 * not spend a round trip revalidating it. Safe only because the file name carries a hash of the
 * contents: a changed file is a different URL, so there is no cached answer to go stale.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Everything else: the shell, the service worker, the manifest, the icons. `no-cache` is not
 * "do not store", it is "revalidate before using", so these still come back 304 when they have
 * not changed. It has to be this for the two that decide what version of the app a person is
 * running: a cached index.html points at bundles that may be gone, and a cached service worker
 * is an old app that never learns there is a new one.
 */
const REVALIDATE = 'no-cache';

/**
 * Answers a request the router did not match, and reports whether it did. Returning false
 * leaves the request to the 404 problem document, see http/problem.ts.
 */
export type ServeWebApp = (request: FastifyRequest, reply: FastifyReply) => boolean;

export interface WebAppPluginOptions {
  /** Directory holding the built client. See WEB_ROOT in config.ts. */
  root: string;
  /**
   * Everything the API owns. A path under it that matched no route is a misspelled endpoint,
   * and the client has no route there to fall back to, so it stays a problem document. Without
   * this the shell would be answered with a 200 to a request for an endpoint that does not
   * exist, and the caller would find out when it tried to parse HTML as JSON.
   */
  apiPathPrefix: string;
}

/** Every file under root, as the path a browser would ask for it by. */
function servableFiles(root: string): ReadonlySet<string> {
  return new Set(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map(
        (entry) => `/${relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')}`,
      ),
  );
}

/**
 * Registers the sender and returns the handler that uses it.
 *
 * `serve: false` is the whole reason this is not three lines of configuration. Left to itself
 * the plugin registers a wildcard GET, and a wildcard at the root claims every URL no other
 * route did, including `/api/v1/mistyped`, which would then be answered with the app shell and
 * a 200 where this API owes a problem document. It also could not declare `config.auth`, which
 * every route here must, see http/plugins/auth.ts. Serving from the not found handler instead
 * means the router has already confirmed that nothing else wanted the URL.
 */
export async function registerWebApp(
  app: FastifyInstance,
  { root, apiPathPrefix }: WebAppPluginOptions,
): Promise<ServeWebApp> {
  const hashedPrefix = join(root, HASHED_DIR) + sep;

  await app.register(fastifyStatic, {
    root,
    serve: false,
    // Written per file below instead. `send` would otherwise put one Cache-Control on all of
    // them, and the two answers here are opposites.
    cacheControl: false,
    setHeaders(reply, path) {
      reply.header('Cache-Control', path.startsWith(hashedPrefix) ? IMMUTABLE : REVALIDATE);
    },
  });

  // Read once, at startup. The directory is baked into the image and cannot change while the
  // process runs, so this is a lookup rather than a stat on every request for an asset. It is
  // also the safety property: a path that is not literally in this set is never handed to the
  // sender, so there is no traversal to reason about beyond what the set was built from.
  const files = servableFiles(root);

  return (request, reply) => {
    // A cross site POST to an unknown path is not a page anybody is navigating to. Only the
    // methods a browser uses to fetch a document or an asset get one back.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return false;
    }

    // The path alone. A client route may carry a query string and it names no different file.
    const pathname = request.url.split('?', 1)[0] ?? '/';

    if (pathname.startsWith(apiPathPrefix)) {
      return false;
    }

    if (files.has(pathname)) {
      void reply.sendFile(pathname);
      return true;
    }

    // Anything that looks like a file and is not one is a 404, not the shell. Answering
    // /assets/index-abc123.js with HTML is a deployment served half from a stale cache, and
    // saying so plainly beats a syntax error in somebody's console.
    if (pathname.split('/').at(-1)?.includes('.') === true) {
      return false;
    }

    // Everything else is a route belonging to the client's own router.
    void reply.sendFile(APP_SHELL);
    return true;
  };
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The headers a browser is told to enforce, and the one place cross origin requests are let in.
 *
 * Both belong to the same hook because both are decisions about what a browser may do with this
 * API, and because a CORS allowlist that is set somewhere other than where the framing and
 * content type rules are set is an allowlist somebody widens without seeing the rest.
 *
 * Nothing here is reached by a script or a mobile client. These headers constrain a browser, so
 * they are defence for the person using the web app rather than for the server, which is why
 * none of them replaces the origin check in plugins/auth.ts.
 */

/**
 * Two years, which is what the preload lists ask for, and subdomains, because a cookie set on
 * one of ours is offered to all of them.
 *
 * Sent only when this instance is actually served over https, decided by WEB_ORIGIN's scheme
 * exactly as the session cookie's `Secure` flag is. A browser ignores the header over plain
 * http anyway, and sending it in development is how somebody pins localhost to https and spends
 * an afternoon on it.
 */
const HSTS = 'max-age=63072000; includeSubDomains';

/**
 * This API answers JSON and nothing else, so the honest policy is that a document from it may
 * load nothing at all and be framed by nobody. `X-Frame-Options` says the framing half again
 * for browsers that predate `frame-ancestors`.
 */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Swagger UI is a real page: its own scripts and styles, inline, and data: URIs for icons. It
 * gets a policy that lets it run and nothing more, rather than an exemption. It is behind
 * API_DOCS_ENABLED besides, so on an instance that has turned it off this string is unreachable.
 */
const DOCS_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The headers this API reads. An allowlist rather than an echo of what was asked for. */
const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, Idempotency-Key';

const CORS_ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';

/** One day. How long a browser may skip the preflight for a path it has already asked about. */
const CORS_MAX_AGE = '86400';

export interface SecurityPluginOptions {
  /** Whether this instance is served over https. See WEB_ORIGIN in config.ts. */
  secure: boolean;
  /** Path prefix the Swagger UI is served under, which is the one page that needs a looser CSP. */
  docsPathPrefix: string;
  /**
   * Origins allowed to call this API from a browser other than the one it is served to. Empty
   * by default, which means no CORS headers are sent at all and a browser refuses every cross
   * origin read. There is deliberately no way to write a wildcard here: the API answers one
   * person's food diary and every response is credentialed, so `*` would be wrong even where
   * the specification allows it. See CORS_ORIGINS in config.ts.
   */
  corsOrigins: readonly string[];
}

export function registerSecurity(
  app: FastifyInstance,
  { secure, docsPathPrefix, corsOrigins }: SecurityPluginOptions,
): void {
  const allowed = new Set(corsOrigins);

  /**
   * Returns true when the response was sent, which happens for a preflight and nothing else.
   *
   * `Vary: Origin` goes on every response while an allowlist is configured, including the ones
   * that get no allow header. Without it a shared cache can hand a response computed for an
   * allowed origin to a request from a different one.
   */
  function applyCors(request: FastifyRequest, reply: FastifyReply): boolean {
    if (allowed.size === 0) {
      return false;
    }

    reply.header('Vary', 'Origin');

    const origin = request.headers.origin;
    if (origin === undefined || !allowed.has(origin)) {
      return false;
    }

    reply.header('Access-Control-Allow-Origin', origin);
    // The session cookie is the whole point of a browser calling this at all, and a response
    // that allows credentials may never carry a wildcard origin, which is a second reason the
    // allowlist is echoed one entry at a time.
    reply.header('Access-Control-Allow-Credentials', 'true');

    if (
      request.method !== 'OPTIONS' ||
      request.headers['access-control-request-method'] === undefined
    ) {
      return false;
    }

    reply
      .header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS)
      .header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      .header('Access-Control-Max-Age', CORS_MAX_AGE)
      .code(204)
      .send();

    return true;
  }

  app.addHook('onRequest', (request, reply, done) => {
    reply.headers({
      'Content-Security-Policy': request.url.startsWith(docsPathPrefix) ? DOCS_CSP : API_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // No referrer at all, rather than same-origin. A URL in this API can carry a resource id,
      // and there is no page anywhere that has a use for where a request came from.
      'Referrer-Policy': 'no-referrer',
      ...(secure ? { 'Strict-Transport-Security': HSTS } : {}),
    });

    // A preflight is answered here, before authentication, because a browser sends it without
    // credentials by definition and a 401 to it reads as "blocked by CORS" in every console.
    if (applyCors(request, reply)) {
      return;
    }

    done();
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const HSTS = 'max-age=63072000; includeSubDomains';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const DOCS_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; " +
  "worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, Idempotency-Key';

const CORS_ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';

const CORS_MAX_AGE = '86400';

export interface SecurityPluginOptions {
  secure: boolean;
  docsPathPrefix: string;
  servesWebApp: boolean;
  corsOrigins: readonly string[];
}

export function registerSecurity(
  app: FastifyInstance,
  { secure, docsPathPrefix, servesWebApp, corsOrigins }: SecurityPluginOptions,
): void {
  const allowed = new Set(corsOrigins);

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
    // A response that allows credentials may never carry a wildcard origin, so the allowlist is
    // echoed one entry at a time.
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

  function contentSecurityPolicy(request: FastifyRequest): string {
    if (request.url.startsWith(docsPathPrefix)) {
      return DOCS_CSP;
    }

    return servesWebApp && request.routeOptions.url === undefined ? APP_CSP : API_CSP;
  }

  app.addHook('onRequest', (request, reply, done) => {
    reply.headers({
      'Content-Security-Policy': contentSecurityPolicy(request),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(secure ? { 'Strict-Transport-Security': HSTS } : {}),
    });

    // Answered before authentication: a browser sends a preflight without credentials by
    // definition, and a 401 to it reads as "blocked by CORS" in every console.
    if (applyCors(request, reply)) {
      return;
    }

    done();
  });
}

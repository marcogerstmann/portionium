import type { UserRole } from '@portionium/schemas';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { findSessionUser } from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import { hashSessionToken, scopesForRole, type Scope } from '../../domain/auth.js';
import { InsufficientScopeError, UnauthenticatedError } from '../../domain/errors.js';

/**
 * Who is calling, and whether they may. The single place identity is established, and the
 * reason no handler in this codebase ever reads a user id out of a body, a query string or a
 * path segment. Why that matters, and why a foreign row answers 404 rather than 403, is
 * docs/adr/003-multi-user-authorization.md.
 *
 * Three properties hold it together, and each is enforced rather than documented:
 *
 *   Authenticated by default. Every route names the scope it needs, or says `public` in so
 *   many words. A route that says neither stops the server from booting, so a forgotten
 *   annotation is a failure on the developer's machine rather than an open endpoint in
 *   production that nobody notices until it is read about somewhere else.
 *
 *   The public surface is audited as a whole. Boot only checks that each route decided
 *   something; what the shipped app is actually allowed to expose without a credential is a
 *   list in test/http/authorization.test.ts, so widening it is a visible line in a diff rather
 *   than one word added to a route file.
 *
 *   The context is read only. `request.auth` is a getter over a private map, so a handler can
 *   neither replace it nor edit it, and there is no path by which a later hook can promote a
 *   caller to somebody else.
 */

/**
 * The name the session cookie is read from. Nothing writes it yet, the login endpoint still
 * returns the token in the body, which is the sessions story. Reading it now costs three lines
 * and means that story is a change to one endpoint rather than to this plugin as well.
 */
export const SESSION_COOKIE_NAME = 'portionium_session';

/**
 * What a route declares. A scope, or the word that makes an unauthenticated endpoint a
 * decision somebody wrote down.
 */
export type RouteAuth = Scope | 'public';

/**
 * Prefixes owned by a plugin that registers its own routes, which are therefore public without
 * an annotation nobody here can add.
 *
 * One entry, @fastify/swagger-ui, which serves the browsable documentation and a handful of
 * assets under paths that are its business rather than ours, and which is not registered at all
 * unless API_DOCS_ENABLED is on. It is spelled out rather than imported from app.ts, which
 * imports this file: the test beside this plugin asserts the two agree.
 */
export const UNANNOTATED_PUBLIC_PREFIXES: readonly string[] = ['/api/v1/docs'];

/** Who the caller is, established once per request and never afterwards. */
export interface AuthContext {
  userId: string;
  role: UserRole;
  scopes: readonly Scope[];
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The scope a caller needs for this route, or `public`. Optional to TypeScript because
     * routes registered by plugins cannot set it, required in practice: a route of ours that
     * omits it never reaches a client, see the onRoute hook below.
     */
    auth?: RouteAuth;
  }

  interface FastifyInstance {
    /**
     * Every route reachable without a credential, as `METHOD /path`, collected from the router
     * itself rather than from a list somebody maintains. It is what the audit in
     * test/http/authorization.test.ts is compared against, so widening the public surface of
     * the API means changing a line in that test on the same commit.
     */
    publicRoutes: ReadonlySet<string>;
  }

  interface FastifyRequest {
    /**
     * The authenticated caller. Reading this on a public route throws, because a public route
     * has no caller and a handler that assumed otherwise should fail loudly rather than read
     * an id from somewhere else.
     */
    readonly auth: AuthContext;
  }
}

/**
 * Keyed by the request object, so the context is unreachable except through the getter below
 * and disappears with the request it belongs to. A property on the request would be writable
 * by anything holding one, which is the thing this is here to prevent.
 */
const contexts = new WeakMap<FastifyRequest, AuthContext>();

/** `HEAD /x` and `GET /x` are one route as far as this plugin is concerned. */
function routeKey(method: string, url: string): string {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

function isUnannotatedPrefix(url: string): boolean {
  return UNANNOTATED_PUBLIC_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * The credential, from either place a browser or a script can put it.
 *
 * A bearer token wins over a cookie when both are present. A script that went to the trouble of
 * setting the header meant it, and a stale cookie left in a shared client should not quietly
 * take over the identity of a request that named one.
 */
function readCredential(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim() || undefined;
  }

  // Parsed here rather than with a cookie plugin. Session tokens are base64url, so there is
  // nothing to unescape, and this is the only cookie the API reads. Revisit when it is not.
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
}

/**
 * Installs the whole of it on the root instance: the decorator, the boot time check and the
 * per request resolution. Called once, from buildApp, before any route is registered, because
 * an onRoute hook only sees routes registered after it.
 */
export function registerAuth(app: FastifyInstance, { db }: { db: Db }): void {
  const publicRoutes = new Set<string>();
  app.decorate('publicRoutes', publicRoutes as ReadonlySet<string>);

  app.decorateRequest('auth', {
    getter(this: FastifyRequest): AuthContext {
      const context = contexts.get(this);
      if (context === undefined) {
        throw new Error(
          `request.auth was read on ${this.method} ${this.url}, which is a public route. ` +
            'A route that needs a caller declares a scope in its config.',
        );
      }

      return context;
    },
  });

  // The whole of "authenticated by default". A route that decided nothing is a mistake, and
  // this is the last moment at which it is cheap to notice: the server does not start.
  app.addHook('onRoute', (route) => {
    const declared = route.config?.auth;
    const unannotated = declared === undefined && isUnannotatedPrefix(route.url);

    for (const method of [route.method].flat()) {
      const key = routeKey(method, route.url);

      if (declared === 'public' || unannotated) {
        publicRoutes.add(key);
        continue;
      }

      if (declared === undefined) {
        throw new Error(
          `${key} declares no auth. Add config.auth to the route: a scope, or 'public' if it ` +
            'is genuinely reachable without a credential.',
        );
      }
    }
  });

  app.addHook('onRequest', (request, _reply, done) => {
    const requiredScope = request.routeOptions.config?.auth;

    // Public, a route belonging to a plugin, or a request that matched nothing at all and is
    // on its way to the 404 handler. All three leave request.auth unset, which is what makes
    // reading it in a handler a loud failure rather than a quiet undefined.
    if (requiredScope === undefined || requiredScope === 'public') {
      done();
      return;
    }

    const token = readCredential(request);
    // One failure for a missing credential and for a dead one. See UnauthenticatedError.
    const user = token === undefined ? undefined : findSessionUser(db, hashSessionToken(token));

    if (user === undefined) {
      done(new UnauthenticatedError());
      return;
    }

    const scopes = scopesForRole(user.role);

    if (!scopes.includes(requiredScope)) {
      // The one 403 in the API. It says the caller may not do this, never whether the thing
      // they asked about exists, which is a different question answered in the repositories.
      request.log.warn(
        { userId: user.id, requiredScope, route: routeKey(request.method, request.url) },
        'request refused for insufficient scope',
      );

      done(new InsufficientScopeError());
      return;
    }

    // Frozen as well as private. The getter already stops a handler replacing the context, and
    // this stops one editing a field of it in place.
    contexts.set(request, Object.freeze({ userId: user.id, role: user.role, scopes }));
    done();
  });
}

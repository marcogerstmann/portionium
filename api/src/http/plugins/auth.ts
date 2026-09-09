import { expandScopes, type Scope, type UserRole } from '@portionium/schemas';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { findApiTokenUser, findSessionUser, touchApiToken, touchSession } from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import { hashToken, isApiToken, scopesForRole, shouldRecordActivity } from '../../domain/auth.js';
import {
  CsrfOriginRejectedError,
  InsufficientScopeError,
  UnauthenticatedError,
} from '../../domain/errors.js';

/**
 * Who is calling, and whether they may. The single place identity is established, and the
 * reason no handler in this codebase ever reads a user id out of a body, a query string or a
 * path segment. Why that matters, and why a foreign row answers 404 rather than 403, is
 * docs/adr/003-multi-user-authorization.md.
 *
 * Four properties hold it together, and each is enforced rather than documented:
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
 *
 *   A cookie alone never authorises a change. A browser attaches cookies to a cross site
 *   request as willingly as to a first party one, so every mutating request carrying a session
 *   cookie has to show an `Origin` this instance serves. Bearer requests skip that check
 *   because nothing attaches them on a page's behalf.
 */

/** The name the session cookie is written and read under. */
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

/**
 * The methods that can change something, which are the ones a cross site request would be sent
 * to. A safe method is exempt because forging one achieves nothing a page could not do anyway,
 * and because refusing them would break every link into the API from anywhere.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Who the caller is, established once per request and never afterwards. */
export interface AuthContext {
  userId: string;
  role: UserRole;
  scopes: readonly Scope[];
  /**
   * The session this request arrived on, when it arrived on one. Absent for an API token, which
   * is what lets logging out and minting a token refuse a credential that is not a browser.
   */
  sessionId?: string;
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

/** Where the credential came from, which decides whether the CSRF check applies to it. */
interface Credential {
  token: string;
  source: 'bearer' | 'cookie';
}

/**
 * The credential, from either place a browser or a script can put it.
 *
 * A bearer token wins over a cookie when both are present. A script that went to the trouble of
 * setting the header meant it, and a stale cookie left in a shared client should not quietly
 * take over the identity of a request that named one.
 */
function readCredential(request: FastifyRequest): Credential | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token === '' ? undefined : { token, source: 'bearer' };
  }

  // Parsed here rather than with a cookie plugin. Both token formats are base64url with an
  // ASCII prefix, so there is nothing to unescape, and this is the only cookie the API reads.
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);

  return token === undefined || token === '' ? undefined : { token, source: 'cookie' };
}

/**
 * A `Set-Cookie` value for a freshly minted session, and the one place the cookie's attributes
 * are written down.
 *
 * `HttpOnly` is the point of putting the token here at all: the page that signed in cannot read
 * its own credential, so neither can a script injected into it. `SameSite=Lax` keeps the cookie
 * off cross site sub-requests while still surviving a normal link into the app, and the origin
 * check in this plugin is the belt to its braces, because Lax alone still permits a cross site
 * top level POST in some browsers. `Secure` follows the configured origin's scheme, see
 * WEB_ORIGIN in config.ts.
 *
 * `Max-Age` rather than `Expires`, because Max-Age is relative and therefore immune to a client
 * clock that is wrong, which is exactly the client whose session would otherwise never expire.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * The same cookie, already expired. Sent on logout so the browser drops it, alongside the
 * server side delete that is what actually ends the session: a client that ignores this header
 * is still signed out, because the row is gone.
 */
export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

export interface AuthPluginOptions {
  db: Db;
  /** The origin a cookie-authenticated mutating request must name. See config.WEB_ORIGIN. */
  webOrigin: string;
  /** How far a session's expiry is pushed out each time activity is recorded. */
  sessionTtlMs: number;
}

/**
 * Installs the whole of it on the root instance: the decorator, the boot time check and the
 * per request resolution. Called once, from buildApp, before any route is registered, because
 * an onRoute hook only sees routes registered after it.
 */
export function registerAuth(
  app: FastifyInstance,
  { db, webOrigin, sessionTtlMs }: AuthPluginOptions,
): void {
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

  /**
   * A cookie authenticated request that changes something has to have come from the app. The
   * header is checked rather than the cookie because a page can cause a browser to send the
   * cookie and cannot cause it to send a foreign origin, and a request with no `Origin` at all
   * is refused rather than trusted: every browser sets it on a cross origin request, so its
   * absence on a mutation is either an old client or somebody hoping this check is a whitelist.
   */
  function passesOriginCheck(request: FastifyRequest, credential: Credential): boolean {
    return (
      credential.source === 'bearer' ||
      !MUTATING_METHODS.has(request.method) ||
      request.headers.origin === webOrigin
    );
  }

  /**
   * A credential resolved into a caller, or undefined for anything that is not one.
   *
   * The prefix on an API token is what decides which table is read, so a request costs one
   * lookup rather than two. A token's scopes are intersected with its owner's rather than
   * trusted as stored: a user demoted out of `admin` should not keep an admin token that was
   * legitimate when it was minted.
   */
  function resolve(credential: Credential, now: Date): AuthContext | undefined {
    if (isApiToken(credential.token)) {
      const found = findApiTokenUser(db, hashToken(credential.token), now);
      if (found === undefined) {
        return undefined;
      }

      const held = scopesForRole(found.user.role);

      if (shouldRecordActivity(found.token.lastUsedAt, now)) {
        touchApiToken(db, found.token.id, now);
      }

      return {
        userId: found.user.id,
        role: found.user.role,
        scopes: expandScopes(found.token.scopes).filter((scope) => held.includes(scope)),
      };
    }

    const found = findSessionUser(db, hashToken(credential.token), now);
    if (found === undefined) {
      return undefined;
    }

    // The sliding expiry. Throttled, so an active browser writes to this row about once a
    // minute rather than on every request it makes. See ACTIVITY_INTERVAL_MS.
    if (shouldRecordActivity(found.session.lastActivityAt, now)) {
      touchSession(db, found.session.id, now, sessionTtlMs);
    }

    return {
      userId: found.user.id,
      role: found.user.role,
      scopes: scopesForRole(found.user.role),
      sessionId: found.session.id,
    };
  }

  app.addHook('onRequest', (request, _reply, done) => {
    const requiredScope = request.routeOptions.config?.auth;

    // Public, a route belonging to a plugin, or a request that matched nothing at all and is
    // on its way to the 404 handler. All three leave request.auth unset, which is what makes
    // reading it in a handler a loud failure rather than a quiet undefined.
    if (requiredScope === undefined || requiredScope === 'public') {
      done();
      return;
    }

    const credential = readCredential(request);
    // One failure for a missing credential and for a dead one. See UnauthenticatedError.
    if (credential === undefined) {
      done(new UnauthenticatedError());
      return;
    }

    // Before the lookup, so a forged request costs no database read and learns nothing from
    // how long it took.
    if (!passesOriginCheck(request, credential)) {
      request.log.warn(
        { origin: request.headers.origin ?? null, route: routeKey(request.method, request.url) },
        'request refused on the origin check',
      );

      done(new CsrfOriginRejectedError());
      return;
    }

    const context = resolve(credential, new Date());

    if (context === undefined) {
      done(new UnauthenticatedError());
      return;
    }

    if (!context.scopes.includes(requiredScope)) {
      // The one 403 about permissions in the API. It says the caller may not do this, never
      // whether the thing they asked about exists, which is a different question answered in
      // the repositories.
      request.log.warn(
        { userId: context.userId, requiredScope, route: routeKey(request.method, request.url) },
        'request refused for insufficient scope',
      );

      done(new InsufficientScopeError());
      return;
    }

    // Frozen as well as private. The getter already stops a handler replacing the context, and
    // this stops one editing a field of it in place.
    contexts.set(request, Object.freeze(context));
    done();
  });
}

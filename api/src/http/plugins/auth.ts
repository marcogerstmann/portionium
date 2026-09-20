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

export const SESSION_COOKIE_NAME = 'portionium_session';

export type RouteAuth = Scope | 'public';

/**
 * Routes registered by a plugin cannot declare `auth`, so their prefixes are listed here instead.
 */
export const UNANNOTATED_PUBLIC_PREFIXES: readonly string[] = ['/api/v1/docs'];

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthContext {
  userId: string;
  role: UserRole;
  scopes: readonly Scope[];
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }

  interface FastifyInstance {
    publicRoutes: ReadonlySet<string>;

    routeAuth: ReadonlyMap<string, RouteAuth>;
  }

  interface FastifyRequest {
    readonly auth: AuthContext;
  }
}

const contexts = new WeakMap<FastifyRequest, AuthContext>();

function routeKey(method: string, url: string): string {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

function isUnannotatedPrefix(url: string): boolean {
  return UNANNOTATED_PUBLIC_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export interface Credential {
  token: string;
  source: 'bearer' | 'cookie';
}

export function readCredential(request: FastifyRequest): Credential | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token === '' ? undefined : { token, source: 'bearer' };
  }

  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);

  return token === undefined || token === '' ? undefined : { token, source: 'cookie' };
}

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

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

export interface AuthPluginOptions {
  db: Db;
  webOrigin: string;
  sessionTtlMs: number;
}

export function registerAuth(
  app: FastifyInstance,
  { db, webOrigin, sessionTtlMs }: AuthPluginOptions,
): void {
  const publicRoutes = new Set<string>();
  app.decorate('publicRoutes', publicRoutes as ReadonlySet<string>);

  const routeAuth = new Map<string, RouteAuth>();
  app.decorate('routeAuth', routeAuth as ReadonlyMap<string, RouteAuth>);

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

  app.addHook('onRoute', (route) => {
    const declared = route.config?.auth;
    const unannotated = declared === undefined && isUnannotatedPrefix(route.url);

    for (const method of [route.method].flat()) {
      const key = routeKey(method, route.url);

      if (declared === 'public' || unannotated) {
        publicRoutes.add(key);
        routeAuth.set(key, 'public');
        continue;
      }

      if (declared === undefined) {
        throw new Error(
          `${key} declares no auth. Add config.auth to the route: a scope, or 'public' if it ` +
            'is genuinely reachable without a credential.',
        );
      }

      routeAuth.set(key, declared);
    }
  });

  function passesOriginCheck(request: FastifyRequest, credential: Credential): boolean {
    return (
      credential.source === 'bearer' ||
      !MUTATING_METHODS.has(request.method) ||
      request.headers.origin === webOrigin
    );
  }

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

    if (requiredScope === undefined || requiredScope === 'public') {
      done();
      return;
    }

    const credential = readCredential(request);
    if (credential === undefined) {
      done(new UnauthenticatedError());
      return;
    }

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
      request.log.warn(
        { userId: context.userId, requiredScope, route: routeKey(request.method, request.url) },
        'request refused for insufficient scope',
      );

      done(new InsufficientScopeError());
      return;
    }

    contexts.set(request, Object.freeze(context));
    done();
  });
}

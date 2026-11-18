/**
 * Bearer token -> principal. Three paths:
 *  1. Entity API key (`Bearer cbuilder_...`): authenticates as the entity that
 *     created the key — entity-scoped product endpoints only, never account/
 *     membership/credit management. music_api parity.
 *  2. Dev bypass (AUTH_TEST_MODE=1): `Bearer dev:<uid>:<email>` authenticates as that user.
 *  3. Firebase ID token via @sudobility/auth_service (needs FIREBASE_* env; else 401).
 */
import type { Context, Next } from 'hono';
import { errorResponse } from '@sudobility/types';
import { getEnvList, isTestMode } from '../lib/env-helper';
import { isFirebaseConfigured } from '../lib/config';
import { verifyFirebaseToken } from '../services/firebase';
import { entityHelpers, resolveEntity } from '../services/entities';

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  email: string | null;
  siteAdmin: boolean;
  via: 'firebase' | 'test' | 'apikey';
  emailVerified: boolean;
}

export type Principal = UserPrincipal;

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal;
    userId: string;
    /** The signed-in user's email (or null), for entity/invitation routes. */
    userEmail: string | null;
    /** The entity credits are charged to (the user's personal entity). */
    entityId: string;
    requestId: string;
  }
}

/**
 * Routes about the PERSON rather than a workspace: their account, their list of
 * workspaces, their invitations. A signed-in user's `X-Entity-Id` is ignored
 * here (music_api parity).
 *
 * Ignoring it is what lets a client recover from a stale selection. A tab that
 * signs out and registers a new account still holds the old account's workspace
 * id; validating it on `GET /entities` answered 403 to the one request that
 * would have told the client which workspaces it does have, so every request
 * failed for good.
 */
export function isAccountPath(requestPath: string): boolean {
  const path = requestPath.replace(/^\/api\/v1/, '');
  return ['/me', '/entities', '/invitations'].some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

export function isSiteAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return getEnvList('SITEADMIN_EMAILS')
    .concat(getEnvList('ADMIN_EMAILS'))
    .some((a) => a.toLowerCase() === e);
}

/** Parses `dev:<uid>:<email>`; returns null when the token is not of that form. */
export function parseDevToken(
  token: string
): { uid: string; email: string } | null {
  if (!token.startsWith('dev:')) return null;
  const rest = token.slice(4);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const uid = rest.slice(0, i);
  const email = rest.slice(i + 1);
  if (!uid || !email) return null;
  return { uid, email };
}

export type TokenResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: 'unavailable' | 'anonymous' | 'invalid' };

export async function resolveToken(token: string): Promise<TokenResult> {
  const dev = isTestMode() ? parseDevToken(token) : null;
  if (dev) {
    return {
      ok: true,
      principal: {
        kind: 'user',
        userId: dev.uid,
        email: dev.email,
        siteAdmin: isSiteAdminEmail(dev.email),
        via: 'test',
        emailVerified: true,
      },
    };
  }
  if (!isFirebaseConfigured()) return { ok: false, reason: 'unavailable' };
  try {
    const { decoded, anonymous } = await verifyFirebaseToken(token);
    if (anonymous) return { ok: false, reason: 'anonymous' };
    return {
      ok: true,
      principal: {
        kind: 'user',
        userId: decoded.uid,
        email: decoded.email ?? null,
        siteAdmin: isSiteAdminEmail(decoded.email),
        via: 'firebase',
        emailVerified: decoded.email_verified === true,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

const bearer = (c: Context): string | null => {
  const h = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
};

/** Require a signed-in user; populates `principal` and `userId` on the context. */
export async function requireAuth(c: Context, next: Next) {
  const token = bearer(c);
  if (!token) {
    return c.json(errorResponse('Authentication required'), 401);
  }

  // Entity API keys (`cbuilder_...`) are scoped to the entity that created them.
  // They reach entity-backed product endpoints, but never key/membership/
  // invitation management, account data, or credits/coupons. music_api parity.
  // An unrecognised `cbuilder_` token is NOT short-circuited here — it falls
  // through to the normal bearer path, which answers 401.
  if (token.startsWith('cbuilder_')) {
    const keyHelper = entityHelpers.apiKeys;
    const key = await keyHelper?.verifyKey(token);
    if (key && keyHelper) {
      const path = c.req.path.replace(/^\/api\/v1/, '');
      if (
        isAccountPath(c.req.path) ||
        path === '/consumables' ||
        path.startsWith('/consumables/')
      ) {
        return c.json(
          errorResponse('This endpoint is not available to entity API keys'),
          403
        );
      }
      const requestedEntityId = c.req.header('X-Entity-Id');
      if (requestedEntityId && requestedEntityId !== key.entityId) {
        return c.json(
          errorResponse('API key is scoped to a different entity'),
          403
        );
      }
      const principal: Principal = {
        kind: 'user',
        userId: key.createdByUserId,
        email: null,
        siteAdmin: false,
        via: 'apikey',
        emailVerified: false,
      };
      c.set('principal', principal);
      c.set('userId', principal.userId);
      c.set('userEmail', null);
      c.set('entityId', key.entityId);
      void keyHelper.touchLastUsed(key.keyId).catch(() => undefined);
      await next();
      return;
    }
  }

  const result = await resolveToken(token);
  if (!result.ok) {
    const msg =
      result.reason === 'unavailable'
        ? 'Authentication is not configured'
        : result.reason === 'anonymous'
          ? 'Sign in with a full account'
          : 'Invalid or expired token';
    return c.json(errorResponse(msg), 401);
  }
  c.set('principal', result.principal);
  c.set('userId', result.principal.userId);
  c.set('userEmail', result.principal.email);
  // Resolve the entity for EVERY authenticated request (music_api parity):
  // credits and domain data are both entity-scoped, so every route needs it.
  // This also migrates any legacy uid-keyed rows into the personal entity.
  try {
    c.set('entityId', await resolveRequestEntityId(c));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Entity resolution failed';
    return c.json(errorResponse(msg), msg === 'Access denied' ? 403 : 400);
  }
  await next();
}

/**
 * Resolve the entity for a request. X-Entity-Id is honored for members only;
 * absent it, the user's personal entity is used. Migrates legacy uid-keyed
 * credit + domain rows into the personal entity (see resolveEntity).
 */
async function resolveRequestEntityId(c: Context): Promise<string> {
  const principal = c.get('principal');
  // On account paths (/me, /entities, /invitations) a stale X-Entity-Id is
  // ignored so the request that lists the user's workspaces can't 403 itself.
  const requestedEntityId = isAccountPath(c.req.path)
    ? undefined
    : c.req.header('X-Entity-Id');
  const entity = await resolveEntity(
    principal.userId,
    principal.email,
    requestedEntityId
  );
  return entity.id;
}

/** The resolved entity id for the current request (set by requireAuth). */
export function getEntityId(c: Context): string {
  return c.get('entityId');
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthStore, AuthUser } from '../store/auth-store.js';
import { ApiError } from './errors.js';
import { FixedWindowCounter } from './rate-limit.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export const SESSION_COOKIE = 'lumen_session';
const MINUTE_MS = 60_000;
/** Seules routes d'API accessibles sans session. */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login']);

export function readSessionCookie(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=') || null;
  }
  return null;
}

export function sessionCookie(config: ServerConfig, token: string | null): string {
  const attributes = [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${token === null ? 0 : Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (config.cookieSecure) attributes.push('Secure');
  return [`${SESSION_COOKIE}=${token ?? ''}`, ...attributes].join('; ');
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (req.user === null) throw new ApiError(401, 'unauthorized', 'connexion requise');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new ApiError(403, 'forbidden', 'réservé à l’administrateur');
  return user;
}

/**
 * Toute route /api exige une session, flux compris : un relais ouvert serait détourné en
 * proxy. Chaque utilisateur a en plus un quota de requêtes par minute.
 */
export function installAuth(app: FastifyInstance, auth: AuthStore, config: ServerConfig): FixedWindowCounter {
  app.decorateRequest('user', null);
  const quota = new FixedWindowCounter(config.apiRequestsPerMinute, MINUTE_MS);
  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;
    const token = readSessionCookie(req.headers.cookie);
    const now = Date.now();
    const user = token === null ? null : auth.resolveSession(token, now);
    if (user === null) throw new ApiError(401, 'unauthorized', 'connexion requise');
    if (!quota.hit(user.id, now))
      throw new ApiError(429, 'rate_limited', 'trop de requêtes, réessayez dans une minute');
    req.user = user;
  });
  return quota;
}

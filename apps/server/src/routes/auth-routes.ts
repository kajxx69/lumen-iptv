import { CreateUserRequest, LoginRequest, type MeDto } from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { readSessionCookie, requireAdmin, requireUser, sessionCookie } from '../http/auth.js';
import { ApiError, parseOr400 } from '../http/errors.js';
import { FixedWindowCounter } from '../http/rate-limit.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../security/passwords.js';
import type { AuthStore } from '../store/auth-store.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthStore,
  config: ServerConfig,
): FixedWindowCounter {
  // Seuls les échecs comptent : un utilisateur légitime n'est jamais bloqué par ses succès.
  const failures = new FixedWindowCounter(config.loginAttemptsPerWindow, config.loginWindowMs);

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = parseOr400(LoginRequest, req.body);
    const key = `${req.ip}|${username.toLowerCase()}`;
    const now = Date.now();
    if (failures.exhausted(key, now)) {
      throw new ApiError(429, 'rate_limited', 'trop de tentatives, réessayez dans une minute');
    }
    const user = auth.findUserForLogin(username);
    // Vérification systématique, même sans compte : le temps de réponse ne trahit rien.
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (user === null || !valid) {
      failures.hit(key, now);
      req.log.info({ attempt: 'refusée' }, 'connexion refusée');
      throw new ApiError(401, 'unauthorized', 'identifiant ou mot de passe incorrect');
    }
    const token = auth.createSession(user.id, now);
    req.log.info({ user: user.username }, 'connexion');
    return reply.header('Set-Cookie', sessionCookie(config, token)).code(204).send();
  });

  app.post('/api/auth/logout', async (req, reply) => {
    requireUser(req);
    const token = readSessionCookie(req.headers.cookie);
    if (token !== null) auth.deleteSession(token);
    return reply.header('Set-Cookie', sessionCookie(config, null)).code(204).send();
  });

  app.get('/api/auth/me', (req): MeDto => {
    const user = requireUser(req);
    return { username: user.username, role: user.role };
  });

  app.post('/api/users', async (req, reply) => {
    requireAdmin(req);
    const body = parseOr400(CreateUserRequest, req.body);
    const created = auth.createUser(body.username, await hashPassword(body.password), body.role, Date.now());
    if (created === null) throw new ApiError(409, 'conflict', 'ce nom d’utilisateur existe déjà');
    return reply.code(201).send({ username: created.username, role: created.role } satisfies MeDto);
  });

  return failures;
}

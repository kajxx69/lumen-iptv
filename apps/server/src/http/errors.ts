import { StalkerError } from '@lumen/core/stalker';
import type { ErrorCode, ErrorDto } from '@lumen/protocol';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { z } from 'zod';

/** Erreur exposée au client : code stable, message sans détail interne. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what: string): ApiError => new ApiError(404, 'not_found', `${what} introuvable`);

export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.') || 'corps').join(', ');
    throw new ApiError(400, 'bad_request', `requête invalide (${fields})`);
  }
  return result.data;
}

/**
 * Traduit une erreur du portail pour le client. Le message reste générique : jamais
 * d'URL, de MAC ni de détail du protocole.
 */
export function fromStalker(err: StalkerError, status = 502): ApiError {
  switch (err.kind) {
    case 'device_rejected':
      return new ApiError(status, 'portal_device_rejected', 'le portail refuse cet appareil (MAC ou modèle)');
    case 'auth_required':
    case 'auth_failed':
    case 'account_inactive':
      return new ApiError(
        status,
        'portal_auth_failed',
        'le portail refuse les identifiants ou le compte est inactif',
      );
    case 'nothing_to_play':
      return new ApiError(404, 'nothing_to_play', 'le portail n’a rien à lire pour cette chaîne');
    case 'rate_limited':
      return new ApiError(503, 'portal_error', 'le portail limite temporairement les requêtes');
    case 'network':
    case 'timeout':
    case 'endpoint_not_found':
    case 'invalid_config':
      return new ApiError(status, 'portal_unreachable', 'portail injoignable ou adresse incorrecte');
    default:
      return new ApiError(status, 'portal_error', 'le portail a répondu de façon inattendue');
  }
}

const body = (code: ErrorCode, message: string): ErrorDto => ({ error: { code, message } });

export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | StalkerError | Error, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(body(err.code, err.message));
    if (err instanceof StalkerError) {
      req.log.warn({ kind: err.kind, status: err.status }, 'erreur du portail');
      const api = fromStalker(err);
      return reply.code(api.status).send(body(api.code, api.message));
    }
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send(body(status === 404 ? 'not_found' : 'bad_request', 'requête invalide'));
    }
    req.log.error({ err }, 'erreur interne');
    return reply.code(500).send(body('internal', 'erreur interne'));
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(body('not_found', 'ressource introuvable')));
}

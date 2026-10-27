import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { ApiError, notFound } from '../http/errors.js';
import type { MetricsRegistry } from '../metrics/registry.js';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * /metrics pour Prometheus, hors de /api : un collecteur n'a pas de session. Protégé par
 * un jeton dédié ; désactivé (404) tant qu'aucun jeton n'est configuré.
 */
export function registerMetricsRoute(
  app: FastifyInstance,
  registry: MetricsRegistry,
  config: ServerConfig,
): void {
  app.get('/metrics', (req, reply) => {
    const expected = config.metricsToken;
    if (expected === undefined) throw notFound('ressource');
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new ApiError(401, 'unauthorized', 'jeton invalide');
    return reply
      .header('Content-Type', PROMETHEUS_CONTENT_TYPE)
      .header('Cache-Control', 'no-store')
      .send(registry.render());
  });
}

import type { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { type Logger, type LoggerOptions, pino } from 'pino';
import { CatalogService } from './catalog/catalog-service.js';
import type { ServerConfig } from './config.js';
import { installAuth } from './http/auth.js';
import { installErrorHandlers } from './http/errors.js';
import { installHttpHooks } from './http/hooks.js';
import { PlaybackService } from './playback/playback-service.js';
import { PortalRegistry, nodeRuntime } from './portals/registry.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerPlaybackRoutes } from './routes/playback-routes.js';
import { registerPortalRoutes } from './routes/portal-routes.js';
import { hashPassword } from './security/passwords.js';
import { SecretBox } from './security/secret-box.js';
import { AuthStore } from './store/auth-store.js';
import { CatalogStore } from './store/catalog-store.js';
import { openDatabase } from './store/database.js';
import { PortalStore } from './store/portal-store.js';

export interface LumenServer {
  app: FastifyInstance;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  /** Destination des journaux (tests) ; stdout par défaut. */
  logStream?: Writable;
}

const HOUSEKEEPING_INTERVAL_MS = 60_000;
// Les corps de requête de l'API sont de petits objets JSON ; au-delà, c'est un abus.
const REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

// Page d'attente jusqu'à l'interface web (phase 4). Aucun script : la CSP l'interdirait.
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen</title></head>
<body><h1>Lumen</h1><p>Le serveur fonctionne. L’interface web arrive en phase 4.</p></body></html>`;

/**
 * Journaux structurés : jamais de cookie, d'en-tête d'autorisation ni de requête d'URL
 * (elle pourrait porter des paramètres sensibles).
 */
function createLogger(config: ServerConfig, stream?: Writable): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.mac', '*.token'],
      censor: '[masqué]',
    },
    serializers: {
      req: (req: { method: string; url: string; id: string }) => ({
        method: req.method,
        url: req.url.split('?')[0],
        id: req.id,
      }),
    },
  };
  return stream === undefined ? pino(options) : pino(options, stream);
}

export async function createServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): Promise<LumenServer> {
  const logger: FastifyBaseLogger = createLogger(config, options.logStream);
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.trustProxy,
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });

  const db = openDatabase(config.databasePath);
  const authStore = new AuthStore(db, config.sessionTtlMs);
  const portalStore = new PortalStore(db, new SecretBox(config.masterKey));
  const registry = new PortalRegistry(portalStore, nodeRuntime(app.log));
  const catalog = new CatalogService(new CatalogStore(db), registry, config, app.log);
  const playback = new PlaybackService(registry, catalog, config, app.log);

  if (authStore.countUsers() === 0) {
    if (config.adminPassword === undefined) {
      app.log.warn('aucun compte : définissez LUMEN_ADMIN_PASSWORD pour créer l’administrateur');
    } else {
      authStore.createUser(
        config.adminUsername,
        await hashPassword(config.adminPassword),
        'admin',
        Date.now(),
      );
      app.log.info({ user: config.adminUsername }, 'administrateur initial créé');
    }
  }

  installErrorHandlers(app);
  installHttpHooks(app);
  const quota = installAuth(app, authStore, config);
  const loginFailures = registerAuthRoutes(app, authStore, config);
  registerPortalRoutes(app, { store: portalStore, registry, catalog, config });
  registerPlaybackRoutes(app, playback);
  app.get('/api/health', () => Promise.resolve({ status: 'ok' }));
  app.get('/', (_req, reply) => reply.type('text/html; charset=utf-8').send(PLACEHOLDER_HTML));

  const housekeeping = setInterval(() => {
    const now = Date.now();
    quota.sweep(now);
    loginFailures.sweep(now);
    authStore.purgeExpiredSessions(now);
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref();

  return {
    app,
    close: async () => {
      clearInterval(housekeeping);
      playback.closeAll();
      registry.closeAll();
      await app.close();
      db.close();
    },
  };
}

import type { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { type Logger, type LoggerOptions, pino } from 'pino';
import { CatalogService } from './catalog/catalog-service.js';
import type { ServerConfig } from './config.js';
import { installAuth } from './http/auth.js';
import { installErrorHandlers } from './http/errors.js';
import { installHttpHooks } from './http/hooks.js';
import { registerProcessMetrics } from './metrics/process-metrics.js';
import { MetricsRegistry } from './metrics/registry.js';
import { PlaybackService } from './playback/playback-service.js';
import { PortalHealth } from './portals/portal-health.js';
import { FfmpegContentAnalyzer } from './resilience/content-analyzer.js';
import { HealthService } from './resilience/health-service.js';
import { ProbeScheduler } from './resilience/probe-scheduler.js';
import { ProbeWorker } from './resilience/probe-worker.js';
import { PortalRegistry, nodeRuntime } from './portals/registry.js';
import { RelayManager } from './relay/relay-manager.js';
import { relayManagerOptions } from './relay/relay-options.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerLibraryRoutes } from './routes/library-routes.js';
import { registerWebRoutes } from './routes/web-routes.js';
import { LibraryStore } from './store/library-store.js';
import { registerMetricsRoute } from './routes/metrics-route.js';
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
  const catalogStore = new CatalogStore(db);
  const catalog = new CatalogService(catalogStore, registry, config, app.log);
  const portalHealth = new PortalHealth(registry, catalogStore);
  const metrics = new MetricsRegistry();
  registerProcessMetrics(metrics);
  const health = new HealthService(db);
  const content = config.contentDetection
    ? new FfmpegContentAnalyzer(config.ffmpegPath, config.contentAnalysisMaxConcurrent, () => {
        app.log.warn('FFmpeg introuvable : détection d’écran noir et de silence désactivée');
      })
    : null;
  const relays = new RelayManager(
    {
      ...relayManagerOptions(config),
      health: (source, event) => {
        health.record({ portalId: source.portalId, channelId: source.channelId }, event);
      },
      ...(content === null ? {} : { content }),
    },
    metrics,
    app.log,
  );
  const library = new LibraryStore(db);
  const playback = new PlaybackService(registry, catalog, relays, library, health, config, app.log);
  const probes = config.probes
    ? new ProbeWorker(
        new ProbeScheduler(
          {
            favoritesIntervalMs: config.probeFavoritesIntervalMs,
            catalogStartHour: config.probeCatalogStartHour,
            catalogEndHour: config.probeCatalogEndHour,
            catalogProbesPerHour: config.probeCatalogPerHour,
          },
          {
            favorites: () => library.allFavorites(),
            catalog: () => catalogStore.allChannelRefs(),
            portalBusy: (portalId) => relays.portalBusy(portalId),
          },
        ),
        { registry, catalog, health, log: app.log },
      )
    : null;
  probes?.start();

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
  registerPortalRoutes(app, { store: portalStore, registry, catalog, config, health: portalHealth });
  registerPlaybackRoutes(app, playback);
  registerLibraryRoutes(app, { library, catalog });
  registerMetricsRoute(app, metrics, config);
  app.get('/api/health', () => Promise.resolve({ status: 'ok' }));
  await registerWebRoutes(app, config.webRoot);

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
      probes?.stop();
      playback.closeAll();
      relays.closeAll();
      registry.closeAll();
      await app.close();
      health.close();
      db.close();
    },
  };
}

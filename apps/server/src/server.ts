import type { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { type Logger, type LoggerOptions, pino } from 'pino';
import { CatalogService } from './catalog/catalog-service.js';
import { GridChecker } from './catalog/grid-checker.js';
import { MergeService } from './catalog/merge-service.js';
import { VodCatalogService } from './catalog/vod-catalog-service.js';
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
import { registerMergeRoutes } from './routes/merge-routes.js';
import { registerVodPlaybackRoutes, registerVodRoutes } from './routes/vod-routes.js';
import { VodSourceProxy } from './vod/source-proxy.js';
import { vodPlaybackOptions } from './vod/vod-options.js';
import { VodPlaybackService } from './vod/vod-service.js';
import { registerWebRoutes } from './routes/web-routes.js';
import { LibraryStore } from './store/library-store.js';
import { registerMetricsRoute } from './routes/metrics-route.js';
import { registerPlaybackRoutes } from './routes/playback-routes.js';
import { registerPortalRoutes } from './routes/portal-routes.js';
import { hashPassword } from './security/passwords.js';
import { SecretBox } from './security/secret-box.js';
import { TranscodeService } from './transcode/transcode-service.js';
import { AuthStore } from './store/auth-store.js';
import { CatalogStore } from './store/catalog-store.js';
import { openDatabase } from './store/database.js';
import { MergeStore } from './store/merge-store.js';
import { PortalStore } from './store/portal-store.js';
import { ProgressStore } from './store/progress-store.js';
import { VodStore } from './store/vod-store.js';

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
  const vod = new VodCatalogService(
    { ttlMs: config.vodCatalogTtlMs, seriesCacheTtlMs: config.vodSeriesCacheTtlMs },
    { store: new VodStore(db), registry, portalIds: () => portalStore.list().map((p) => p.id), log: app.log },
  );
  const mergeStore = new MergeStore(db);
  const merge = new MergeService(mergeStore, catalogStore);
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
  const transcodes = config.transcoding
    ? new TranscodeService(
        {
          ffmpegPath: config.ffmpegPath,
          encoder: config.transcodeEncoder,
          maxVideo: config.transcodeMaxVideo,
          transcode: {
            maxHeight: config.transcodeMaxHeight,
            audioBitrateKbps: config.transcodeAudioBitrateKbps,
          },
        },
        relays.cache,
        app.log,
      )
    : null;
  if (transcodes !== null) {
    metrics.gauge(
      'lumen_transcodes_active',
      'Sorties transcodées en cours (audio ou vidéo)',
      () => transcodes.activeCount.all,
    );
    metrics.gauge(
      'lumen_transcodes_video_active',
      'Transcodages vidéo en cours (les plus coûteux, plafonnés)',
      () => transcodes.activeCount.video,
    );
    metrics.gauge(
      'lumen_transcode_hardware',
      'Encodeur vidéo matériel en service (1) ou processeur (0)',
      () => (transcodes.encoderChoice?.hardware === true ? 1 : 0),
    );
  }
  const playback = new PlaybackService(
    registry,
    catalog,
    relays,
    library,
    health,
    merge,
    transcodes,
    config,
    app.log,
  );
  const vodProxy = new VodSourceProxy(
    { connectTimeoutMs: config.upstreamTimeoutMs, retryDeadlineMs: config.vodUpstreamRetryDeadlineMs },
    app.log,
  );
  await vodProxy.listen();
  const vodPlayback = new VodPlaybackService(vodPlaybackOptions(config), {
    vod,
    catalog,
    merge,
    registry,
    proxy: vodProxy,
    transcodes,
    log: app.log,
  });
  metrics.gauge('lumen_vod_sessions_active', 'Lectures de films en cours', () => vodPlayback.activeCount);
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
  const gridChecks = config.gridChecks
    ? new GridChecker(
        {
          perHour: config.gridChecksPerHour,
          startHour: config.probeCatalogStartHour,
          endHour: config.probeCatalogEndHour,
        },
        {
          merge,
          store: mergeStore,
          grid: async (ref, from, to) =>
            (await registry.get(ref.portalId).provider.getEpg(ref.channelId, { from, to })).map((e) => ({
              title: e.title,
              start: e.start,
              end: e.end,
            })),
          portalBusy: (portalId) => relays.portalBusy(portalId),
          log: app.log,
        },
      )
    : null;
  gridChecks?.start();

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
  registerPortalRoutes(app, { store: portalStore, registry, catalog, config, health: portalHealth, merge });
  registerMergeRoutes(app, { merge, store: mergeStore, registry });
  registerPlaybackRoutes(app, playback);
  registerLibraryRoutes(app, { library, catalog, merge, progress: new ProgressStore(db), registry });
  registerVodRoutes(app, { vod, registry, config });
  registerVodPlaybackRoutes(app, vodPlayback);
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
      gridChecks?.stop();
      playback.closeAll();
      vodPlayback.closeAll();
      await vodProxy.close();
      relays.closeAll();
      registry.closeAll();
      await app.close();
      health.close();
      db.close();
    },
  };
}

import Fastify, { type FastifyInstance } from 'fastify';
import { ChaosController } from './chaos/controller.js';
import { registerChaosRoutes } from './chaos/routes.js';
import { type Clock, systemClock } from './clock.js';
import { type FakePortalConfig, type FakePortalConfigInput, resolveConfig } from './config.js';
import { type MediaAssets, loadMediaAssets } from './media/assets.js';
import { StreamConnections } from './media/connections.js';
import { LiveTimeline, SegmentRenderer } from './media/renderer.js';
import { registerStreamRoutes } from './media/stream-routes.js';
import { registerStalkerApi } from './stalker/api.js';
import { Catalog } from './stalker/catalog.js';
import { SessionStore } from './stalker/sessions.js';

export interface FakePortal {
  app: FastifyInstance;
  config: FakePortalConfig;
  chaos: ChaosController;
  catalog: Catalog;
  timeline: LiveTimeline;
  renderer: SegmentRenderer;
  connections: StreamConnections;
}

export interface CreateOptions {
  clock?: Clock;
  /** Évite de recharger les mires quand un test crée plusieurs portails. */
  assets?: MediaAssets;
}

// Logo et affiche factices : PNG 1×1 transparent.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Retire la requête des URL journalisées : elle contient MAC et tokens. */
const redactUrl = (url: string): string => url.split('?')[0] ?? url;

export async function createFakePortal(
  overrides: FakePortalConfigInput = {},
  options: CreateOptions = {},
): Promise<FakePortal> {
  const config = resolveConfig(overrides);
  const clock = options.clock ?? systemClock;
  const assets = options.assets ?? (await loadMediaAssets(config.media, config.assetDir, config.ffmpegPath));

  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: redactUrl(req.url) }),
      },
    },
  });

  const chaos = new ChaosController(clock);
  const sessions = new SessionStore(config, clock);
  const connections = new StreamConnections();
  const catalog = new Catalog(config);
  const timeline = new LiveTimeline(clock.now() - config.liveEpochPrerollMs, config.media.segmentDurationS);
  const renderer = new SegmentRenderer(assets, timeline, chaos, config.corruptPacketRatio);

  chaos.subscribe({
    onDrop: (window) => connections.kill(window.channelId),
    onExpireTokens: (killStreams) => {
      sessions.expireAll();
      if (killStreams) connections.kill(null);
    },
  });

  // Un portail qui s'arrête coupe ses flux : sans cela, la fermeture attendrait la fin de
  // flux en direct qui ne finissent jamais.
  app.addHook('preClose', (done) => {
    connections.kill(null);
    done();
  });

  app.get('/_health', () => Promise.resolve({ status: 'ok', name: config.portalName }));
  app.get('/logos/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    return /^\d+\.png$/.test(file) ? reply.type('image/png').send(PLACEHOLDER_PNG) : reply.code(404).send();
  });
  app.get('/posters/:file', async (_req, reply) => reply.type('image/png').send(PLACEHOLDER_PNG));

  registerStalkerApi(app, { config, clock, chaos, sessions, catalog });
  registerStreamRoutes(app, { config, clock, chaos, sessions, renderer, connections });
  if (config.chaosEnabled) registerChaosRoutes(app, { chaos, sessions, connections });

  return { app, config, chaos, catalog, timeline, renderer, connections };
}

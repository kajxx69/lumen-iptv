import { type MovieListDto, type SeriesListDto, VodPlayRequest } from '@lumen/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { VodCatalogService } from '../catalog/vod-catalog-service.js';
import type { ServerConfig } from '../config.js';
import { requireUser } from '../http/auth.js';
import { notFound, parseOr400 } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { VodPlaybackService } from '../vod/vod-service.js';
import { sendPortalImage } from './image-proxy.js';

const Id = z.string().min(1).max(128);
const PortalParams = z.object({ portalId: Id });
const MovieParams = PortalParams.extend({ movieId: Id });
const SeriesParams = PortalParams.extend({ seriesId: Id });
const SeasonParams = SeriesParams.extend({ seasonId: Id });
const SessionParams = z.object({ sessionId: z.string().min(1).max(64) });
const SegmentParams = SessionParams.extend({ file: z.string().regex(/^\d{1,9}\.ts$/) });

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const TS_CONTENT_TYPE = 'video/mp2t';
/** Un segment ne change jamais : le navigateur le garde pour un retour en arrière sans retéléchargement. */
const SEGMENT_CACHE_CONTROL = 'private, max-age=600, immutable';

interface VodRouteDeps {
  vod: VodCatalogService;
  registry: PortalRegistry;
  config: ServerConfig;
}

/** Revalidation systématique, mais un catalogue inchangé ne coûte qu'un 304. */
function sendList(
  req: FastifyRequest,
  reply: FastifyReply,
  list: MovieListDto | SeriesListDto,
): MovieListDto | SeriesListDto | FastifyReply {
  const etag = `"${list.version}"`;
  reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  return list;
}

/** Catalogue de films et de séries : listes, fiches, saisons, épisodes, affiches. */
export function registerVodRoutes(app: FastifyInstance, { vod, registry, config }: VodRouteDeps): void {
  const images = { upstreamTimeoutMs: config.upstreamTimeoutMs, cacheMaxAgeS: config.logoCacheMaxAgeS };

  app.get('/api/portals/:portalId/movies', async (req, reply) => {
    requireUser(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    return sendList(req, reply, await vod.movies(portalId));
  });

  app.get('/api/portals/:portalId/movies/:movieId', async (req) => {
    requireUser(req);
    const { portalId, movieId } = parseOr400(MovieParams, req.params);
    return vod.movieDetail(portalId, movieId);
  });

  app.get('/api/portals/:portalId/movies/:movieId/poster', async (req, reply) => {
    requireUser(req);
    const { portalId, movieId } = parseOr400(MovieParams, req.params);
    const poster = await vod.poster(portalId, 'movie', movieId);
    if (poster === null) throw notFound('affiche');
    return sendPortalImage(reply, registry.get(portalId), poster, 'affiche', images);
  });

  app.get('/api/portals/:portalId/series', async (req, reply) => {
    requireUser(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    return sendList(req, reply, await vod.series(portalId));
  });

  app.get('/api/portals/:portalId/series/:seriesId', async (req) => {
    requireUser(req);
    const { portalId, seriesId } = parseOr400(SeriesParams, req.params);
    return vod.seriesDetail(portalId, seriesId);
  });

  app.get('/api/portals/:portalId/series/:seriesId/poster', async (req, reply) => {
    requireUser(req);
    const { portalId, seriesId } = parseOr400(SeriesParams, req.params);
    const poster = await vod.poster(portalId, 'series', seriesId);
    if (poster === null) throw notFound('affiche');
    return sendPortalImage(reply, registry.get(portalId), poster, 'affiche', images);
  });

  app.get('/api/portals/:portalId/series/:seriesId/seasons/:seasonId', async (req) => {
    requireUser(req);
    const { portalId, seriesId, seasonId } = parseOr400(SeasonParams, req.params);
    return vod.episodes(portalId, seriesId, seasonId);
  });
}

/** Lecture de films et d'épisodes : ouverture, playlist, segments, arrêt. */
export function registerVodPlaybackRoutes(app: FastifyInstance, playback: VodPlaybackService): void {
  app.post('/api/vod/sessions', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(await playback.start(user, parseOr400(VodPlayRequest, req.body)));
  });

  app.get('/api/vod/sessions/:sessionId/playlist.m3u8', (req, reply) => {
    const user = requireUser(req);
    const { sessionId } = parseOr400(SessionParams, req.params);
    // Playlist qui grandit tant que le fichier se lit : jamais en cache.
    return reply
      .header('Content-Type', HLS_CONTENT_TYPE)
      .header('Cache-Control', 'no-store')
      .send(playback.playlist(user, sessionId));
  });

  app.get('/api/vod/sessions/:sessionId/:file', (req, reply) => {
    const user = requireUser(req);
    const { sessionId, file } = parseOr400(SegmentParams, req.params);
    return reply
      .header('Content-Type', TS_CONTENT_TYPE)
      .header('Cache-Control', SEGMENT_CACHE_CONTROL)
      .send(playback.segment(user, sessionId, Number.parseInt(file, 10)));
  });

  app.delete('/api/vod/sessions/:sessionId', (req, reply) => {
    const user = requireUser(req);
    playback.stop(user, parseOr400(SessionParams, req.params).sessionId);
    return reply.code(204).send();
  });
}

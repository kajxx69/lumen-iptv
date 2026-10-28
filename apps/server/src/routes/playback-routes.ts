import {
  type ChannelHealthDto,
  PlaybackQualityRequest,
  PlaybackRequest,
  PlaybackStatsRequest,
  type PlaybackStatusDto,
} from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../http/auth.js';
import { parseOr400 } from '../http/errors.js';
import type { PlaybackService } from '../playback/playback-service.js';

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const TS_CONTENT_TYPE = 'video/mp2t';
/**
 * Un segment ne change jamais une fois publié : le navigateur peut le garder le temps du
 * tampon maximal (retour arrière sans retéléchargement, données mobiles économisées).
 */
const SEGMENT_CACHE_CONTROL = 'private, max-age=120, immutable';

const SessionParams = z.object({ sessionId: z.string().min(1) });
const ChannelParams = z.object({ portalId: z.string().min(1), channelId: z.string().min(1) });
/** Rechargement bloquant (RFC 8216bis) : segment `_HLS_msn`, et sa partie `_HLS_part` en LL-HLS. */
const BlockingQuery = z.object({
  _HLS_msn: z.coerce.number().int().nonnegative().optional(),
  _HLS_part: z.coerce.number().int().nonnegative().optional(),
});
/** `<n>.ts` : segment ; `<n>.<partie>.ts` : partie de segment (LL-HLS). */
const SEGMENT_FILE = /^(\d{1,15})(?:\.(\d{1,4}))?\.ts$/;
const SegmentParams = SessionParams.extend({ file: z.string().regex(SEGMENT_FILE) });

export function registerPlaybackRoutes(app: FastifyInstance, playback: PlaybackService): void {
  app.post('/api/playback', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(await playback.start(user, parseOr400(PlaybackRequest, req.body)));
  });

  app.get('/api/playback/:sessionId/index.m3u8', async (req, reply) => {
    const user = requireUser(req);
    const { sessionId } = parseOr400(SessionParams, req.params);
    const { _HLS_msn: msn, _HLS_part: part } = parseOr400(BlockingQuery, req.query);
    const text = await playback.playlist(user, sessionId, msn, part);
    // Playlist en direct : jamais en cache, elle change à chaque segment.
    return reply.header('Content-Type', HLS_CONTENT_TYPE).header('Cache-Control', 'no-store').send(text);
  });

  app.post('/api/playback/:sessionId/stats', async (req, reply) => {
    const user = requireUser(req);
    const { sessionId } = parseOr400(SessionParams, req.params);
    playback.recordStats(user, sessionId, parseOr400(PlaybackStatsRequest, req.body));
    return reply.code(204).send();
  });

  /** Changement de qualité (réseau, économie de données) : appliqué sans recharger la playlist. */
  app.post('/api/playback/:sessionId/quality', async (req): Promise<PlaybackStatusDto> => {
    const user = requireUser(req);
    const { sessionId } = parseOr400(SessionParams, req.params);
    return playback.setQuality(user, sessionId, parseOr400(PlaybackQualityRequest, req.body).quality);
  });

  app.get('/api/playback/:sessionId/seg/:file', async (req, reply) => {
    const user = requireUser(req);
    const { sessionId, file } = parseOr400(SegmentParams, req.params);
    const [, seq = '', part] = SEGMENT_FILE.exec(file) ?? [];
    const data = await playback.segment(
      user,
      sessionId,
      Number.parseInt(seq, 10),
      part === undefined ? undefined : Number.parseInt(part, 10),
    );
    return reply
      .header('Content-Type', TS_CONTENT_TYPE)
      .header('Cache-Control', SEGMENT_CACHE_CONTROL)
      .send(data);
  });

  app.get('/api/playback/:sessionId/status', (req): PlaybackStatusDto => {
    const user = requireUser(req);
    return playback.status(user, parseOr400(SessionParams, req.params).sessionId);
  });

  app.get('/api/portals/:portalId/channels/:channelId/health', async (req): Promise<ChannelHealthDto> => {
    requireUser(req);
    return playback.channelHealth(parseOr400(ChannelParams, req.params));
  });

  app.delete('/api/playback/:sessionId', async (req, reply) => {
    const user = requireUser(req);
    playback.stop(user, parseOr400(SessionParams, req.params).sessionId);
    return reply.code(204).send();
  });
}

import { PlaybackRequest, type PlaybackStatusDto } from '@lumen/protocol';
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
const SegmentParams = SessionParams.extend({ file: z.string().regex(/^\d{1,15}\.ts$/) });

export function registerPlaybackRoutes(app: FastifyInstance, playback: PlaybackService): void {
  app.post('/api/playback', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(await playback.start(user, parseOr400(PlaybackRequest, req.body)));
  });

  app.get('/api/playback/:sessionId/index.m3u8', (req, reply) => {
    const user = requireUser(req);
    const { sessionId } = parseOr400(SessionParams, req.params);
    // Playlist en direct : jamais en cache, elle change à chaque segment.
    return reply
      .header('Content-Type', HLS_CONTENT_TYPE)
      .header('Cache-Control', 'no-store')
      .send(playback.playlist(user, sessionId));
  });

  app.get('/api/playback/:sessionId/seg/:file', (req, reply) => {
    const user = requireUser(req);
    const { sessionId, file } = parseOr400(SegmentParams, req.params);
    const data = playback.segment(user, sessionId, Number.parseInt(file, 10));
    return reply
      .header('Content-Type', TS_CONTENT_TYPE)
      .header('Cache-Control', SEGMENT_CACHE_CONTROL)
      .send(data);
  });

  app.get('/api/playback/:sessionId/status', (req): PlaybackStatusDto => {
    const user = requireUser(req);
    return playback.status(user, parseOr400(SessionParams, req.params).sessionId);
  });

  app.delete('/api/playback/:sessionId', async (req, reply) => {
    const user = requireUser(req);
    playback.stop(user, parseOr400(SessionParams, req.params).sessionId);
    return reply.code(204).send();
  });
}

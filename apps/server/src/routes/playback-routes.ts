import { PlaybackRequest } from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../http/auth.js';
import { parseOr400 } from '../http/errors.js';
import type { PlaybackService } from '../playback/playback-service.js';

const SessionParams = z.object({ sessionId: z.string().min(1) });
const SegmentParams = SessionParams.extend({ key: z.coerce.number().int().nonnegative() });

export function registerPlaybackRoutes(app: FastifyInstance, playback: PlaybackService): void {
  app.post('/api/playback', async (req, reply) => {
    const user = requireUser(req);
    const { portalId, channelId } = parseOr400(PlaybackRequest, req.body);
    return reply.code(201).send(await playback.start(user, portalId, channelId));
  });

  app.get('/api/playback/:sessionId/stream', async (req, reply) => {
    const user = requireUser(req);
    const { sessionId } = parseOr400(SessionParams, req.params);
    return playback.stream(user, sessionId, reply);
  });

  app.get('/api/playback/:sessionId/hls/:key', async (req, reply) => {
    const user = requireUser(req);
    const { sessionId, key } = parseOr400(SegmentParams, req.params);
    return playback.segment(user, sessionId, key, reply);
  });

  app.delete('/api/playback/:sessionId', async (req, reply) => {
    const user = requireUser(req);
    playback.stop(user, parseOr400(SessionParams, req.params).sessionId);
    return reply.code(204).send();
  });
}

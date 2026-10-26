import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StreamConnections } from '../media/connections.js';
import type { SessionStore } from '../stalker/sessions.js';
import type { ChaosController } from './controller.js';

const duration = z.number().int().positive();
const channelId = z
  .union([z.string().min(1), z.number().int()])
  .transform(String)
  .optional();
const seed = z.number().int().optional();

const schemas = {
  latency: z.object({ ms: z.number().int().nonnegative(), scope: z.enum(['api', 'stream']) }),
  drop: z.object({ durationMs: duration, channelId }),
  expireToken: z.object({ killStreams: z.boolean().default(true) }),
  httpError: z.object({
    code: z.number().int().min(400).max(599),
    probability: z.number().min(0).max(1),
    scope: z.enum(['api', 'stream', 'all']).default('all'),
    seed,
  }),
  throttle: z.object({ bitrateKbps: z.number().positive() }),
  corrupt: z.object({ segmentProbability: z.number().min(0).max(1), seed }),
  freeze: z.object({ durationMs: duration, channelId }),
  blackscreen: z.object({ durationMs: duration, channelId }),
};

export interface ChaosRouteDeps {
  chaos: ChaosController;
  sessions: SessionStore;
  connections: StreamConnections;
}

export function registerChaosRoutes(
  app: FastifyInstance,
  { chaos, sessions, connections }: ChaosRouteDeps,
): void {
  function post<S extends z.ZodType>(path: string, schema: S, apply: (body: z.output<S>) => unknown): void {
    app.post(path, async (req, reply) => {
      // Un POST sans corps vaut {} : `expire-token` et `reset` n'ont pas de paramètre obligatoire.
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      const result = apply(parsed.data);
      return reply.send({ ok: true, ...(result === undefined ? {} : { result }), state: chaos.snapshot() });
    });
  }

  post('/_chaos/latency', schemas.latency, (b) => {
    chaos.setLatency(b.ms, b.scope);
  });
  post('/_chaos/drop', schemas.drop, (b) => chaos.drop(b.durationMs, b.channelId ?? null));
  post('/_chaos/expire-token', schemas.expireToken, (b) => {
    chaos.expireTokens(b.killStreams);
  });
  post('/_chaos/http-error', schemas.httpError, (b) => {
    chaos.setHttpError({ code: b.code, probability: b.probability, scope: b.scope }, b.seed);
  });
  post('/_chaos/throttle', schemas.throttle, (b) => {
    chaos.setThrottle(b.bitrateKbps);
  });
  post('/_chaos/corrupt', schemas.corrupt, (b) => {
    chaos.setCorrupt(b.segmentProbability, b.seed);
  });
  post('/_chaos/freeze', schemas.freeze, (b) => chaos.freeze(b.durationMs, b.channelId ?? null));
  post('/_chaos/blackscreen', schemas.blackscreen, (b) =>
    chaos.blackscreen(b.durationMs, b.channelId ?? null),
  );
  post('/_chaos/reset', z.object({}), () => {
    chaos.reset();
    // Un test qui a déclenché un bannissement ne doit pas contaminer le suivant.
    sessions.resetBans();
  });

  app.get('/_chaos/state', () =>
    Promise.resolve({ ...chaos.snapshot(), activeStreams: connections.countByChannel() }),
  );
}

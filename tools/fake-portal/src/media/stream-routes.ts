import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChaosController } from '../chaos/controller.js';
import { type Clock, sleep } from '../clock.js';
import type { FakePortalConfig } from '../config.js';
import type { PlayKind, SessionStore } from '../stalker/sessions.js';
import { type StreamConnections, writeOut } from './connections.js';
import { ContinuityRewriter } from './mpegts.js';
import type { SegmentRenderer } from './renderer.js';

export interface StreamDeps {
  config: FakePortalConfig;
  clock: Clock;
  chaos: ChaosController;
  sessions: SessionStore;
  renderer: SegmentRenderer;
  connections: StreamConnections;
}

const TS_CONTENT_TYPE = 'video/mp2t';
const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const LiveQuery = z.object({
  stream: z.string().min(1),
  extension: z.enum(['ts', 'm3u8']).default('ts'),
  play_token: z.string().min(1),
});
const MovieQuery = z.object({ stream: z.string().min(1), play_token: z.string().min(1) });
const ArchiveQuery = z.object({
  stream: z.string().min(1),
  start: z.coerce.number().int(),
  duration: z.coerce.number().int().positive(),
  play_token: z.string().min(1),
});
const SegmentParams = z.object({ stream: z.string().min(1), file: z.string().regex(/^-?\d+\.ts$/) });
const SegmentQuery = z.object({ play_token: z.string().min(1) });

export const archiveStreamId = (channelId: string, startSec: number, durationMin: number): string =>
  `${channelId}_${startSec}_${durationMin}`;

export function registerStreamRoutes(app: FastifyInstance, deps: StreamDeps): void {
  const { config, clock, chaos, sessions, renderer, connections } = deps;
  const timeline = renderer.timeline;

  /** Pannes communes à toute requête de flux. Renvoie false si la requête a déjà été traitée. */
  async function gate(req: FastifyRequest, reply: FastifyReply, channelId: string): Promise<boolean> {
    const latency = chaos.latencyFor('stream');
    if (latency > 0) await sleep(latency);
    const code = chaos.injectedHttpError('stream');
    if (code !== null) {
      await reply.code(code).type('text/plain').send(`Injected HTTP ${code}`);
      return false;
    }
    if (chaos.isDropped(channelId)) {
      reply.hijack();
      req.raw.socket.destroy();
      return false;
    }
    return true;
  }

  async function authorize(
    reply: FastifyReply,
    token: string,
    kind: PlayKind,
    streamId: string,
    reusable: boolean,
  ): Promise<boolean> {
    const check = sessions.consumePlay(token, kind, streamId, reusable);
    if (check.ok) return true;
    await reply.code(403).type('text/plain').send(`Forbidden: ${check.reason}`);
    return false;
  }

  function openStream(
    reply: FastifyReply,
    channelId: string,
    headers: Record<string, string | number>,
    status = 200,
  ): FastifyReply['raw'] {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(status, { 'Content-Type': TS_CONTENT_TYPE, 'Cache-Control': 'no-store', ...headers });
    connections.add(channelId, res);
    return res;
  }

  async function pump(
    log: FastifyBaseLogger,
    res: FastifyReply['raw'],
    producer: () => Promise<void>,
  ): Promise<void> {
    try {
      await producer();
    } catch (err) {
      log.warn({ err }, 'flux interrompu');
      res.destroy();
    }
  }

  /** Flux TS continu, cadencé comme un encodeur en direct. */
  async function streamLiveTs(req: FastifyRequest, reply: FastifyReply, channelId: string): Promise<void> {
    const res = openStream(reply, channelId, { Connection: 'close' });
    const chunks = config.tsPacingChunksPerSegment;
    const continuity = new ContinuityRewriter();
    let k = timeline.segmentAt(clock.now()) - config.tsInitialBurstSegments;
    // Fonction plutôt que lecture directe : la socket peut se fermer pendant chaque await.
    const open = (): boolean => !res.destroyed;
    await pump(req.log, res, async () => {
      while (open()) {
        const asset = renderer.assetFor(channelId, k);
        const total = renderer.packetCount(asset, k);
        for (let i = 0; i < chunks && open(); i++) {
          // Un morceau part quand son contenu a été « produit » : à la fin de sa tranche de temps.
          const dueMs = timeline.segmentStartMs(k) + ((i + 1) * timeline.segmentMs) / chunks;
          await sleep(dueMs - clock.now());
          if (!open()) break;
          const range = {
            from: Math.floor((i * total) / chunks),
            to: Math.floor(((i + 1) * total) / chunks),
          };
          const buf = renderer.render(channelId, k, asset, range);
          continuity.rewrite(buf);
          await writeOut(res, buf, chaos);
        }
        k++;
      }
    });
  }

  function livePlaylist(channelId: string, token: string): string {
    const latest = timeline.segmentAt(clock.now()) - 1;
    const first = latest - config.hlsWindowSegments + 1;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${config.media.segmentDurationS}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
    ];
    for (let k = first; k <= latest; k++) {
      lines.push(`#EXTINF:${config.media.segmentDurationS.toFixed(3)},`);
      lines.push(`/hls/${encodeURIComponent(channelId)}/${k}.ts?play_token=${token}`);
    }
    return `${lines.join('\n')}\n`;
  }

  app.get('/play/live.php', async (req, reply) => {
    const q = LiveQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).type('text/plain').send('Bad request');
    const { stream, extension, play_token: token } = q.data;
    if (!(await gate(req, reply, stream))) return reply;
    if (!(await authorize(reply, token, 'live', stream, extension === 'm3u8'))) return reply;
    if (extension === 'm3u8') {
      return reply
        .header('Cache-Control', 'no-store')
        .type(HLS_CONTENT_TYPE)
        .send(livePlaylist(stream, token));
    }
    await streamLiveTs(req, reply, stream);
    return reply;
  });

  app.get('/hls/:stream/:file', async (req, reply) => {
    const p = SegmentParams.safeParse(req.params);
    const q = SegmentQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).type('text/plain').send('Bad request');
    const { stream } = p.data;
    const k = Number.parseInt(p.data.file, 10);
    if (!(await gate(req, reply, stream))) return reply;
    if (!(await authorize(reply, q.data.play_token, 'live', stream, true))) return reply;
    const latest = timeline.segmentAt(clock.now()) - 1;
    const oldest = latest - config.hlsWindowSegments - config.hlsRetainSegments + 1;
    if (k > latest || k < oldest) return reply.code(404).type('text/plain').send('Segment not available');
    const buf = renderer.render(stream, k);
    const res = openStream(reply, stream, { 'Content-Length': buf.length });
    await pump(req.log, res, async () => {
      await writeOut(res, buf, chaos);
      res.end();
    });
    return reply;
  });

  app.get('/play/movie.php', async (req, reply) => {
    const q = MovieQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).type('text/plain').send('Bad request');
    const { stream, play_token: token } = q.data;
    if (!(await gate(req, reply, stream))) return reply;
    // Un lecteur VOD rouvre le fichier à chaque saut (requêtes Range) : lien réutilisable.
    if (!(await authorize(reply, token, 'vod', stream, true))) return reply;
    const body = renderMovie(stream);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = body.length - 1;
    if (range !== null) {
      start = range[1] === '' ? body.length - Number(range[2]) : Number(range[1]);
      end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), end) : end;
      if (start > end || start < 0) {
        return reply.code(416).header('Content-Range', `bytes */${body.length}`).send();
      }
    }
    const slice = body.subarray(start, end + 1);
    const headers: Record<string, string | number> = {
      'Content-Length': slice.length,
      'Accept-Ranges': 'bytes',
    };
    if (range !== null) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
    const res = openStream(reply, stream, headers, range === null ? 200 : 206);
    await pump(req.log, res, async () => {
      await writeOut(res, slice, chaos);
      res.end();
    });
    return reply;
  });

  /** Un film est la boucle de mire, une fois, avec des horodatages partant de zéro. */
  function renderMovie(streamId: string): Buffer {
    const continuity = new ContinuityRewriter();
    const count = config.media.loopDurationS / config.media.segmentDurationS;
    const parts: Buffer[] = [];
    for (let k = 0; k < count; k++) {
      const buf = renderer.render(`vod:${streamId}`, k, renderer.assetFor(`vod:${streamId}`, k));
      continuity.rewrite(buf);
      parts.push(buf);
    }
    return Buffer.concat(parts);
  }

  app.get('/play/archive.php', async (req, reply) => {
    const q = ArchiveQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).type('text/plain').send('Bad request');
    const { stream, start, duration, play_token: token } = q.data;
    if (!(await gate(req, reply, stream))) return reply;
    if (!(await authorize(reply, token, 'archive', archiveStreamId(stream, start, duration), false)))
      return reply;
    const minutes = Math.min(duration, config.archiveMaxDurationMin);
    const first = timeline.segmentAt(start * 1000);
    const count = Math.ceil((minutes * 60) / config.media.segmentDurationS);
    const res = openStream(reply, stream, { Connection: 'close' });
    const continuity = new ContinuityRewriter();
    await pump(req.log, res, async () => {
      for (let k = first; k < first + count && !res.destroyed; k++) {
        const buf = renderer.render(stream, k);
        continuity.rewrite(buf);
        await writeOut(res, buf, chaos);
      }
      res.end();
    });
    return reply;
  });
}

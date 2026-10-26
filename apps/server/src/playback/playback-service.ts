import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ResolvedLink } from '@lumen/core/stalker';
import type { PlaybackDto } from '@lumen/protocol';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { ServerConfig } from '../config.js';
import { ApiError, notFound } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { AuthUser } from '../store/auth-store.js';

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const TS_CONTENT_TYPE = 'video/mp2t';
/**
 * Un lien TS amont est à usage unique et expire vite : celui résolu au démarrage n'est
 * réutilisé que pour la première connexion, et seulement s'il est récent.
 */
const FRESH_LINK_MS = 10_000;
/** Correspondances segment → URL amont conservées par session (≈ 2 min de HLS à 2 s). */
const MAX_TRACKED_SEGMENTS = 64;
const URI_ATTRIBUTE = /URI="([^"]+)"/g;

interface PlaybackSession {
  id: string;
  userId: string;
  portalId: string;
  channelId: string;
  cmd: string;
  format: 'ts' | 'hls';
  link: ResolvedLink;
  linkUsed: boolean;
  lastSeen: number;
  /** Clé opaque → URL amont : le client ne voit jamais l'adresse réelle d'un segment. */
  segments: Map<number, string>;
  nextSegmentKey: number;
  upstreams: Set<AbortController>;
  log: FastifyBaseLogger;
}

/**
 * Proxy de lecture (phase 2) : une connexion amont par connexion cliente. Le tampon
 * glissant et le partage d'une connexion entre spectateurs arrivent avec le relais (phase 3).
 */
export class PlaybackService {
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly registry: PortalRegistry,
    private readonly catalog: CatalogService,
    private readonly config: ServerConfig,
    private readonly log: FastifyBaseLogger,
  ) {
    this.sweeper = setInterval(
      () => {
        this.sweep();
      },
      Math.max(100, config.playbackIdleTtlMs / 2),
    );
    this.sweeper.unref();
  }

  async start(user: AuthUser, portalId: string, channelId: string): Promise<PlaybackDto> {
    const mine = [...this.sessions.values()].filter((s) => s.userId === user.id).length;
    if (mine >= this.config.maxStreamsPerUser || this.sessions.size >= this.config.maxStreamsTotal) {
      throw new ApiError(429, 'too_many_streams', 'nombre maximal de lectures simultanées atteint');
    }
    const channel = await this.catalog.channel(portalId, channelId);
    if (channel === null) throw notFound('chaîne');
    const portal = this.registry.get(portalId);
    const link = await portal.provider.client.createLink(channel.cmd);
    const id = randomUUID();
    const session: PlaybackSession = {
      id,
      userId: user.id,
      portalId,
      channelId,
      cmd: channel.cmd,
      format: link.format === 'hls' ? 'hls' : 'ts',
      link,
      linkUsed: false,
      lastSeen: Date.now(),
      segments: new Map(),
      nextSegmentKey: 0,
      upstreams: new Set(),
      // Identifiant de corrélation : suit cette lecture de bout en bout dans les journaux.
      log: this.log.child({ cid: id }),
    };
    this.sessions.set(id, session);
    session.log.info({ portal: portalId, channel: channelId, format: session.format }, 'lecture démarrée');
    return { sessionId: id, streamUrl: `/api/playback/${id}/stream`, format: session.format };
  }

  private owned(user: AuthUser, sessionId: string): PlaybackSession {
    const session = this.sessions.get(sessionId);
    // Même réponse pour « inexistante » et « à quelqu'un d'autre » : rien à deviner.
    if (session?.userId !== user.id) throw notFound('lecture');
    session.lastSeen = Date.now();
    return session;
  }

  stop(user: AuthUser, sessionId: string): void {
    this.close(this.owned(user, sessionId), 'arrêtée par le client');
  }

  private close(session: PlaybackSession, reason: string): void {
    for (const upstream of session.upstreams) upstream.abort();
    this.sessions.delete(session.id);
    session.log.info({ reason }, 'lecture terminée');
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.upstreams.size === 0 && now - session.lastSeen > this.config.playbackIdleTtlMs) {
        this.close(session, 'inactive');
      }
    }
  }

  closeAll(): void {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) this.close(session, 'arrêt du serveur');
  }

  /** Lien amont à utiliser : celui du démarrage s'il est neuf, sinon un nouveau create_link. */
  private async linkFor(session: PlaybackSession, reusable: boolean): Promise<ResolvedLink> {
    const fresh = Date.now() - session.link.resolvedAt < FRESH_LINK_MS;
    if (reusable || (!session.linkUsed && fresh)) {
      session.linkUsed = true;
      return session.link;
    }
    session.link = await this.registry.get(session.portalId).provider.client.createLink(session.cmd);
    session.linkUsed = true;
    return session.link;
  }

  /**
   * Requête amont dont la fermeture suit celle du client : un spectateur parti ne laisse
   * pas de connexion ouverte sur la MAC du portail.
   */
  private async fetchUpstream(session: PlaybackSession, url: string, reply: FastifyReply): Promise<Response> {
    const controller = new AbortController();
    session.upstreams.add(controller);
    const release = (): void => {
      controller.abort();
      session.upstreams.delete(controller);
      session.lastSeen = Date.now();
    };
    // Fermeture de la réponse (fin d'envoi ou client parti), pas de la requête : depuis Node 16
    // celle-ci peut se fermer dès qu'elle est lue.
    reply.raw.on('close', release);
    const timer = setTimeout(() => {
      controller.abort();
    }, this.config.upstreamTimeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.registry.get(session.portalId).userAgent, Accept: '*/*' },
        signal: controller.signal,
      });
      if (!res.ok) {
        session.log.warn({ status: res.status }, 'réponse amont en erreur');
        throw new ApiError(502, 'portal_error', 'le serveur de flux a refusé la lecture');
      }
      return res;
    } catch (err) {
      release();
      if (err instanceof ApiError) throw err;
      session.log.warn(
        { reason: controller.signal.aborted ? 'délai ou client parti' : 'réseau' },
        'flux amont injoignable',
      );
      throw new ApiError(502, 'portal_unreachable', 'serveur de flux injoignable');
    } finally {
      clearTimeout(timer);
    }
  }

  private pipe(
    session: PlaybackSession,
    res: Response,
    reply: FastifyReply,
    contentType: string,
  ): FastifyReply {
    if (res.body === null) throw new ApiError(502, 'portal_error', 'flux amont vide');
    session.log.info({ contentType }, 'flux ouvert');
    const stream = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    stream.on('close', () => {
      session.log.debug('flux fermé');
    });
    stream.on('error', () => {
      session.log.debug('flux amont interrompu');
    });
    return reply.header('Content-Type', contentType).header('Cache-Control', 'no-store').send(stream);
  }

  /** Réécrit chaque URI d'une playlist vers une clé opaque servie par le backend. */
  private rewritePlaylist(session: PlaybackSession, text: string, base: string): string {
    const register = (uri: string): string => {
      const key = session.nextSegmentKey++;
      session.segments.set(key, new URL(uri, base).href);
      if (session.segments.size > MAX_TRACKED_SEGMENTS) {
        const oldest = session.segments.keys().next().value;
        if (oldest !== undefined) session.segments.delete(oldest);
      }
      return `/api/playback/${session.id}/hls/${key}`;
    };
    return text
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed === '') return line;
        if (trimmed.startsWith('#'))
          return line.replace(URI_ATTRIBUTE, (_m, uri: string) => `URI="${register(uri)}"`);
        return register(trimmed);
      })
      .join('\n');
  }

  private async sendPlaylist(
    session: PlaybackSession,
    upstream: Response,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const text = await upstream.text();
    return reply
      .header('Content-Type', HLS_CONTENT_TYPE)
      .header('Cache-Control', 'no-store')
      .send(this.rewritePlaylist(session, text, upstream.url));
  }

  async stream(user: AuthUser, sessionId: string, reply: FastifyReply): Promise<FastifyReply> {
    const session = this.owned(user, sessionId);
    // HLS : le lien reste valable tant que la session portail vit ; TS : usage unique.
    const link = await this.linkFor(session, session.format === 'hls');
    const upstream = await this.fetchUpstream(session, link.url, reply);
    if (session.format === 'hls') return this.sendPlaylist(session, upstream, reply);
    return this.pipe(session, upstream, reply, TS_CONTENT_TYPE);
  }

  async segment(user: AuthUser, sessionId: string, key: number, reply: FastifyReply): Promise<FastifyReply> {
    const session = this.owned(user, sessionId);
    const url = session.segments.get(key);
    if (url === undefined) throw notFound('segment');
    const upstream = await this.fetchUpstream(session, url, reply);
    const type = upstream.headers.get('content-type') ?? '';
    // Playlist imbriquée (variante de qualité) : elle doit être réécrite elle aussi.
    if (type.includes('mpegurl') || new URL(url).pathname.endsWith('.m3u8')) {
      return this.sendPlaylist(session, upstream, reply);
    }
    return this.pipe(
      session,
      upstream,
      reply,
      type === '' || type.includes('octet-stream') ? TS_CONTENT_TYPE : type,
    );
  }
}

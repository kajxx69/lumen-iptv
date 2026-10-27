import { randomUUID } from 'node:crypto';
import type { ChannelRef, PlaybackDto, PlaybackRequest } from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { ServerConfig } from '../config.js';
import { ApiError, notFound } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { Relay, RelaySource } from '../relay/relay.js';
import type { RelayManager } from '../relay/relay-manager.js';
import type { AuthUser } from '../store/auth-store.js';

/** URI des segments, relative à la playlist : `/api/playback/<id>/seg/<n>.ts`. */
const segmentUri = (seq: number): string => `seg/${seq}.ts`;

interface ViewerSession {
  id: string;
  userId: string;
  relay: Relay;
  lastSeen: number;
  /** Le lecteur a demandé sa première playlist : journalisé une fois, pas à chaque rechargement. */
  attached: boolean;
  log: FastifyBaseLogger;
}

/**
 * Sessions de lecture : chaque spectateur est rattaché au relais de sa chaîne. La
 * session porte les droits (propriétaire, quotas) ; le relais porte le flux.
 */
export class PlaybackService {
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly registry: PortalRegistry,
    private readonly catalog: CatalogService,
    private readonly relays: RelayManager,
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

  async start(user: AuthUser, request: PlaybackRequest): Promise<PlaybackDto> {
    const mine = [...this.sessions.values()].filter((s) => s.userId === user.id).length;
    if (mine >= this.config.maxStreamsPerUser || this.sessions.size >= this.config.maxStreamsTotal) {
      throw new ApiError(429, 'too_many_streams', 'nombre maximal de lectures simultanées atteint');
    }
    // Toutes les sources sont vérifiées avant d'ouvrir quoi que ce soit en amont.
    const refs = [request, ...request.fallbacks];
    const sources = await Promise.all(refs.map((ref) => this.sourceFor(ref)));
    const relay = this.relays.acquire(sourceId(request), sources);
    const id = randomUUID();
    // Identifiant de corrélation : suit cette lecture de bout en bout dans les journaux.
    const log = this.log.child({ cid: id, relay: relay.id });
    const session: ViewerSession = { id, userId: user.id, relay, lastSeen: Date.now(), attached: false, log };
    this.sessions.set(id, session);
    try {
      await relay.ready(this.config.relayStartTimeoutMs);
    } catch {
      this.sessions.delete(id);
      this.relays.release(relay, relay.state === 'starting');
      log.warn({ sources: sources.length }, 'lecture impossible : aucune source ne répond');
      throw new ApiError(502, 'stream_unavailable', 'la chaîne ne répond pas, sur aucune de ses sources');
    }
    log.info(
      { portal: request.portalId, channel: request.channelId, fallbacks: request.fallbacks.length },
      'lecture démarrée',
    );
    return { sessionId: id, streamUrl: `/api/playback/${id}/index.m3u8`, format: 'hls' };
  }

  private async sourceFor(ref: ChannelRef): Promise<RelaySource> {
    const portal = this.registry.get(ref.portalId);
    const channel = await this.catalog.channel(ref.portalId, ref.channelId);
    if (channel === null) throw notFound('chaîne');
    return {
      id: sourceId(ref),
      portalId: ref.portalId,
      resolve: async () => {
        const link = await portal.provider.client.createLink(channel.cmd);
        return { url: link.url, format: link.format, userAgent: portal.userAgent };
      },
    };
  }

  private owned(user: AuthUser, sessionId: string): ViewerSession {
    const session = this.sessions.get(sessionId);
    // Même réponse pour « inexistante » et « à quelqu'un d'autre » : rien à deviner.
    if (session?.userId !== user.id) throw notFound('lecture');
    session.lastSeen = Date.now();
    return session;
  }

  playlist(user: AuthUser, sessionId: string): string {
    const session = this.owned(user, sessionId);
    if (!session.attached) {
      session.attached = true;
      session.log.info({ state: session.relay.state }, 'lecteur rattaché au relais');
    }
    return session.relay.playlist(segmentUri);
  }

  segment(user: AuthUser, sessionId: string, seq: number): Buffer {
    const session = this.owned(user, sessionId);
    const data = session.relay.segment(seq);
    if (data === undefined) throw notFound('segment');
    this.relays.metrics.bytesOut.inc({}, data.length);
    return data;
  }

  stop(user: AuthUser, sessionId: string): void {
    this.close(this.owned(user, sessionId), 'arrêtée par le client');
  }

  private close(session: ViewerSession, reason: string): void {
    if (!this.sessions.delete(session.id)) return;
    this.relays.release(session.relay);
    session.log.info({ reason }, 'lecture terminée');
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastSeen > this.config.playbackIdleTtlMs) this.close(session, 'inactive');
    }
  }

  closeAll(): void {
    clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) this.close(session, 'arrêt du serveur');
  }
}

const sourceId = (ref: ChannelRef): string => `${ref.portalId}:${ref.channelId}`;

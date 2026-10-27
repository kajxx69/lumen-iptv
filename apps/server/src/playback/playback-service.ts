import { randomUUID } from 'node:crypto';
import { rankSources } from '@lumen/core/resilience';
import {
  type ChannelHealthDto,
  type ChannelRef,
  MAX_FALLBACK_SOURCES,
  type PlaybackDto,
  type PlaybackRequest,
  type PlaybackStatsRequest,
  type PlaybackStatusDto,
} from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { ServerConfig } from '../config.js';
import { ApiError, notFound } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { HealthService } from '../resilience/health-service.js';
import type { Relay, RelaySource } from '../relay/relay.js';
import type { RelayManager } from '../relay/relay-manager.js';
import type { AuthUser } from '../store/auth-store.js';
import type { LibraryStore } from '../store/library-store.js';

/** URI des segments, relative à la playlist : `/api/playback/<id>/seg/<n>.ts`. */
const segmentUri = (seq: number): string => `seg/${seq}.ts`;
/**
 * Attente maximale d'un rechargement bloquant. La RFC permet trois durées cibles (18 s) ;
 * 8 s restent sous le délai de chargement de playlist de hls.js (10 s), qui sinon
 * compterait une erreur. À l'échéance, la playlist actuelle part et le lecteur redemande.
 */
const BLOCKING_RELOAD_MAX_MS = 8000;
/** Un lecteur peut demander au plus le segment d'après le prochain. */
const MAX_BLOCKING_AHEAD_SEGMENTS = 2;

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
    private readonly library: LibraryStore,
    private readonly health: HealthService,
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
    const refs = await this.candidates(request);
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
    this.library.touchRecent(user.id, request.portalId, request.channelId, Date.now());
    return { sessionId: id, streamUrl: `/api/playback/${id}/index.m3u8`, format: 'hls' };
  }

  status(user: AuthUser, sessionId: string): PlaybackStatusDto {
    const relay = this.owned(user, sessionId).relay;
    const state = relay.state;
    // Un relais fermé sous la session (arrêt du serveur) se présente comme en reprise.
    return { state: state === 'closed' ? 'recovering' : state, ...relay.status };
  }

  /**
   * Sources d'une chaîne, de la meilleure à la moins bonne : celle demandée, celles fournies
   * par le client, puis la même chaîne trouvée sur les autres portails. Classées par score
   * de santé, jamais par l'ordre de la liste (PROJECT.md §3) ; à égalité, celle demandée.
   */
  private async candidates(request: PlaybackRequest): Promise<ChannelRef[]> {
    const discovered = await this.catalog.alternatives(request.portalId, request.channelId);
    const all = [request, ...request.fallbacks, ...discovered];
    const unique = all.filter(
      (ref, i) => all.findIndex((r) => r.portalId === ref.portalId && r.channelId === ref.channelId) === i,
    );
    const ranked = rankSources(
      unique.slice(0, 1 + MAX_FALLBACK_SOURCES).map((ref) => ({
        ref: { portalId: ref.portalId, channelId: ref.channelId },
        score: this.health.health(ref).score,
      })),
    );
    return ranked.map((r) => r.ref);
  }

  /** Santé de toutes les sources connues d'une chaîne (diagnostic, indicateur de santé). */
  async channelHealth(ref: ChannelRef): Promise<ChannelHealthDto> {
    if ((await this.catalog.channel(ref.portalId, ref.channelId)) === null) throw notFound('chaîne');
    const refs = await this.candidates({ ...ref, fallbacks: [] });
    return { sources: refs.map((r) => ({ ...r, ...this.health.health(r) })) };
  }

  private async sourceFor(ref: ChannelRef): Promise<RelaySource> {
    const portal = this.registry.get(ref.portalId);
    const channel = await this.catalog.channel(ref.portalId, ref.channelId);
    if (channel === null) throw notFound('chaîne');
    return {
      id: sourceId(ref),
      portalId: ref.portalId,
      channelId: ref.channelId,
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

  /**
   * Playlist du relais. Avec `waitForSeq` (rechargement bloquant, `_HLS_msn`), la réponse
   * attend que ce segment paraisse : le lecteur le reçoit à l'instant de sa publication.
   */
  async playlist(user: AuthUser, sessionId: string, waitForSeq?: number): Promise<string> {
    const session = this.owned(user, sessionId);
    if (!session.attached) {
      session.attached = true;
      session.log.info({ state: session.relay.state }, 'lecteur rattaché au relais');
    }
    const relay = session.relay;
    if (waitForSeq !== undefined) {
      // Trop loin dans le futur : le lecteur se trompe (RFC 8216bis : 400).
      if (waitForSeq > relay.nextSeq + MAX_BLOCKING_AHEAD_SEGMENTS) {
        throw new ApiError(400, 'bad_request', 'segment demandé trop loin dans le futur');
      }
      await relay.waitForSegment(waitForSeq, BLOCKING_RELOAD_MAX_MS);
      session.lastSeen = Date.now();
    }
    return relay.playlist(segmentUri);
  }

  recordStats(user: AuthUser, sessionId: string, stats: PlaybackStatsRequest): void {
    this.owned(user, sessionId);
    this.relays.metrics.watchSeconds.inc({}, stats.watchedMs / 1000);
    this.relays.metrics.stallSeconds.inc({}, stats.stalledMs / 1000);
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

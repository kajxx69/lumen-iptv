import { randomUUID } from 'node:crypto';
import { diversifyHosts, rankSources } from '@lumen/core/resilience';
import {
  ALL_PORTALS_ID,
  type ChannelHealthDto,
  type ChannelRef,
  MAX_FALLBACK_SOURCES,
  type PlaybackDto,
  type PlaybackRequest,
  type PlaybackStatsRequest,
  type PlaybackStatusDto,
  type QualityProfile,
} from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { MergeService } from '../catalog/merge-service.js';
import type { ServerConfig } from '../config.js';
import { ApiError, notFound } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { HealthService } from '../resilience/health-service.js';
import type { Relay, RelaySource } from '../relay/relay.js';
import type { RelayManager } from '../relay/relay-manager.js';
import type { AuthUser } from '../store/auth-store.js';
import type { LibraryStore } from '../store/library-store.js';
import { PASSTHROUGH, planOutput } from '../transcode/plan.js';
import { type TranscodeService, capabilitiesKey } from '../transcode/transcode-service.js';
import { SessionView, type ViewSource } from './session-view.js';
import type { TranscodedOutput } from '../transcode/transcoded-output.js';

/** URI des segments et de leurs parties, relatives à la playlist : `seg/<n>.ts`, `seg/<n>.<partie>.ts`. */
const segmentUri = (seq: number, part?: number): string =>
  part === undefined ? `seg/${seq}.ts` : `seg/${seq}.${part}.ts`;
/**
 * Attente maximale d'un rechargement bloquant. La RFC permet trois durées cibles (18 s) ;
 * 8 s restent sous le délai de chargement de playlist de hls.js (10 s), qui sinon
 * compterait une erreur. À l'échéance, la playlist actuelle part et le lecteur redemande.
 */
const BLOCKING_RELOAD_MAX_MS = 8000;
/** Un lecteur peut demander au plus le segment d'après le prochain. */
const MAX_BLOCKING_AHEAD_SEGMENTS = 2;
/** Clé de la sortie directe du relais (le flux tel quel). */
const DIRECT = 'direct';
/**
 * Qualité réduite refusée (conversions saturées) : la session lit la source et retente au bout
 * de ce délai. Une qualité réduite est une préférence ; elle ne doit jamais priver d'image.
 */
const QUALITY_RETRY_MS = 30_000;

interface ViewerSession {
  id: string;
  userId: string;
  relay: Relay;
  lastSeen: number;
  /** Le lecteur a demandé sa première playlist : journalisé une fois, pas à chaque rechargement. */
  attached: boolean;
  /** « Direct au plus près » : la playlist de cette session annonce les parties (LL-HLS). */
  lowLatency: boolean;
  /** Playlist propre au spectateur, quelle que soit la sortie qu'il lit (voir SessionView). */
  view: SessionView;
  /** Sortie voulue en ce moment : DIRECT, ou la clé d'une sortie transcodée. */
  currentKey: string;
  /** Sortie transcodée voulue en ce moment ; null : la sortie directe. */
  transcoded: TranscodedOutput | null;
  /** Sorties transcodées encore lues par la vue : libérées dès qu'elle les a quittées. */
  held: Map<ViewSource, TranscodedOutput>;
  caps: PlaybackRequest['caps'];
  /** Qualité demandée par le lecteur, et celle servie (elles diffèrent le temps d'un changement). */
  quality: QualityProfile;
  activeQuality: QualityProfile;
  /** Changement de sortie en cours (un seul à la fois). */
  switching: Promise<void> | null;
  /** Qualité réduite refusée : qualité source jusqu'à cet instant, puis nouvel essai. */
  qualityRetryAt: number;
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
    private readonly merge: MergeService,
    /** Absent : transcodage désactivé, les formats illisibles sont refusés clairement. */
    private readonly transcodes: TranscodeService | null,
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
    const relay = this.relays.acquire(this.relayKey(request), sources);
    const id = randomUUID();
    // Identifiant de corrélation : suit cette lecture de bout en bout dans les journaux.
    const log = this.log.child({ cid: id, relay: relay.id });
    const session: ViewerSession = {
      id,
      userId: user.id,
      relay,
      lastSeen: Date.now(),
      attached: false,
      lowLatency: request.lowLatency,
      view: this.newView(relay, relay.output),
      currentKey: DIRECT,
      transcoded: null,
      held: new Map(),
      caps: request.caps,
      quality: request.quality,
      activeQuality: 'source',
      switching: null,
      qualityRetryAt: 0,
      log,
    };
    this.sessions.set(id, session);
    try {
      await relay.ready(this.config.relayStartTimeoutMs);
    } catch {
      this.sessions.delete(id);
      this.relays.release(relay, relay.state === 'starting');
      log.warn({ sources: sources.length }, 'lecture impossible : aucune source ne répond');
      throw new ApiError(502, 'stream_unavailable', 'la chaîne ne répond pas, sur aucune de ses sources');
    }
    await this.ensureOutput(session, true);
    log.info(
      { portal: request.portalId, channel: request.channelId, fallbacks: request.fallbacks.length },
      'lecture démarrée',
    );
    // Récent : toujours une chaîne réelle (la source choisie pour une chaîne fusionnée).
    const watched = request.portalId === ALL_PORTALS_ID ? refs[0] : request;
    if (watched !== undefined)
      this.library.touchRecent(user.id, watched.portalId, watched.channelId, Date.now());
    return { sessionId: id, streamUrl: `/api/playback/${id}/index.m3u8`, format: 'hls' };
  }

  private newView(relay: Relay, source: ViewSource): SessionView {
    const o = relay.mediaOptions;
    return new SessionView(source, o.bufferS, {
      targetDurationS: o.targetDurationS,
      holdBackS: o.holdBackS,
      partTargetS: o.segmenter.partTargetS,
      partHoldBackS: o.partHoldBackS,
    });
  }

  /** Sortie qu'il faut à ce spectateur : la directe si son navigateur lit le flux tel quel en qualité source. */
  private desiredKey(session: ViewerSession): string {
    const streams = session.relay.programStreams;
    const quality = this.effectiveQuality(session);
    const plan = streams === null ? PASSTHROUGH : planOutput(streams, session.caps, quality);
    return plan.key === PASSTHROUGH.key ? DIRECT : `${capabilitiesKey(session.caps)}@${quality}`;
  }

  /** Qualité à servir : celle demandée, sauf pendant le délai qui suit un refus (source). */
  private effectiveQuality(session: ViewerSession): QualityProfile {
    return Date.now() < session.qualityRetryAt ? 'source' : session.quality;
  }

  /**
   * Sortie de la session selon ce que le navigateur sait lire et la qualité demandée : le flux
   * tel quel si possible, sinon une sortie transcodée (partagée avec les spectateurs du même
   * besoin). Au démarrage, un échec est une erreur de lecture ; ensuite, la session garde
   * simplement ce qu'elle lit (le lecteur ne voit jamais de coupure pour un changement raté).
   */
  private async ensureOutput(session: ViewerSession, initial = false): Promise<void> {
    const key = this.desiredKey(session);
    if (key === session.currentKey) return;
    const relay = session.relay;
    if (key === DIRECT) {
      session.view.switchTo(relay.output);
      session.currentKey = DIRECT;
      session.transcoded = null;
      session.activeQuality = 'source';
      this.releaseUnused(session);
      return;
    }
    const abandon = (err: unknown): never => {
      if (initial) {
        this.sessions.delete(session.id);
        this.relays.release(relay);
      }
      throw err;
    };
    if (this.transcodes === null) {
      abandon(
        new ApiError(
          415,
          'unsupported_codec',
          'ce navigateur ne lit pas le format de cette chaîne, et la conversion est désactivée',
        ),
      );
      return;
    }
    const quality = this.effectiveQuality(session);
    let output: TranscodedOutput;
    try {
      output = await this.transcodes.acquire(relay, session.caps, quality);
    } catch (err) {
      if (initial && quality !== 'source' && err instanceof ApiError && err.code === 'transcode_busy') {
        // Pas de place pour une qualité réduite : la lecture démarre quand même, en qualité source.
        session.qualityRetryAt = Date.now() + QUALITY_RETRY_MS;
        session.log.warn({ quality }, 'qualité réduite indisponible (conversions saturées) : qualité source');
        await this.ensureOutput(session, true);
        return;
      }
      abandon(err);
      return;
    }
    try {
      await output.ready(this.config.relayStartTimeoutMs);
    } catch {
      this.transcodes.release(relay, output);
      abandon(new ApiError(502, 'stream_unavailable', 'la conversion de cette chaîne n’a pas démarré'));
      return;
    }
    if (this.sessions.get(session.id) !== session) {
      // Session fermée pendant l'attente : rien à brancher.
      this.transcodes.release(relay, output);
      return;
    }
    session.held.set(output.output, output);
    if (initial) session.view = this.newView(relay, output.output);
    else session.view.switchTo(output.output);
    session.currentKey = key;
    session.transcoded = output;
    session.activeQuality = quality;
    session.log.info({ output: key, plan: output.plan?.key ?? null }, 'sortie de la session choisie');
    this.releaseUnused(session);
  }

  /** Sorties transcodées que la vue n'utilise plus (ni en cours, ni dans sa fenêtre) : libérées. */
  private releaseUnused(session: ViewerSession): void {
    const used = session.view.sourcesInUse();
    for (const [source, output] of session.held) {
      if (used.has(source)) continue;
      session.held.delete(source);
      this.transcodes?.release(session.relay, output);
    }
  }

  /**
   * Vérifie, à chaque playlist, que la session lit la bonne sortie (nouvelle source d'un autre
   * format, qualité changée) et lance le changement en arrière-plan, sans faire attendre.
   */
  private refreshOutput(session: ViewerSession): void {
    this.releaseUnused(session);
    if (session.switching !== null || this.desiredKey(session) === session.currentKey) return;
    session.switching = this.ensureOutput(session)
      .catch((err: unknown) => {
        // Nouvel essai plus tard, pas à chaque playlist (toutes les 2 s).
        session.qualityRetryAt = Date.now() + QUALITY_RETRY_MS;
        session.log.warn(
          { err: err instanceof Error ? err.message : 'inconnue' },
          'changement de sortie impossible : la session garde la sienne',
        );
      })
      .finally(() => {
        session.switching = null;
      });
  }

  /** Qualité demandée par le lecteur (réseau, économie de données) : appliquée sans coupure. */
  async setQuality(user: AuthUser, sessionId: string, quality: QualityProfile): Promise<PlaybackStatusDto> {
    const session = this.owned(user, sessionId);
    const previous = session.quality;
    session.quality = quality;
    await session.switching;
    try {
      await this.ensureOutput(session);
    } catch (err) {
      // Refus (conversions saturées) : la qualité précédente reste demandée et servie.
      session.quality = previous;
      throw err;
    }
    return this.status(user, sessionId);
  }

  status(user: AuthUser, sessionId: string): PlaybackStatusDto {
    const session = this.owned(user, sessionId);
    const relay = session.relay;
    const state = relay.state;
    const plan = session.transcoded?.plan ?? null;
    // Un relais fermé sous la session (arrêt du serveur) se présente comme en reprise.
    return {
      state: state === 'closed' ? 'recovering' : state,
      ...relay.status,
      transcode:
        plan === null || plan.key === PASSTHROUGH.key
          ? null
          : {
              video: plan.video,
              audio: plan.audio,
              hardware: this.transcodes?.encoderChoice?.hardware ?? false,
            },
      quality: { requested: session.quality, active: session.activeQuality },
    };
  }

  /**
   * Un relais par chaîne fusionnée : la vue « Tous les portails » et la vue d'un portail
   * partagent la même connexion amont pour une même chaîne.
   */
  private relayKey(request: ChannelRef): string {
    if (request.portalId === ALL_PORTALS_ID) return `g:${request.channelId}`;
    const group = this.merge.enabled() ? this.merge.groupKeyOf(request) : null;
    return group === null ? sourceId(request) : `g:${group}`;
  }

  /**
   * La même chaîne ailleurs : les sources de sa chaîne fusionnée (corrections manuelles et
   * refus de grille compris) ; fusion désactivée, le seul identifiant EPG, le plus sûr.
   */
  private async discovered(request: ChannelRef): Promise<ChannelRef[]> {
    if (!this.merge.enabled()) return this.catalog.alternatives(request.portalId, request.channelId);
    const group = this.merge.groupKeyOf(request);
    return group === null ? [] : (this.merge.members(group) ?? []);
  }

  /**
   * Sources d'une chaîne, de la meilleure à la moins bonne : celle demandée, celles fournies
   * par le client, puis la même chaîne trouvée sur les autres portails. Classées par score
   * de santé, jamais par l'ordre de la liste (PROJECT.md §3) ; à égalité, celle demandée.
   * Une chaîne fusionnée (« Tous les portails ») n'a que ses sources, toutes à égalité.
   */
  private async candidates(
    request: ChannelRef & { fallbacks: readonly ChannelRef[] },
    limit = 1 + MAX_FALLBACK_SOURCES,
  ): Promise<ChannelRef[]> {
    if (request.portalId === ALL_PORTALS_ID) {
      const members = this.merge.members(request.channelId);
      if (members === null || members.length === 0) throw notFound('chaîne');
      return this.rank(members, limit);
    }
    const all = [request, ...request.fallbacks, ...(await this.discovered(request))];
    const unique = all.filter(
      (ref, i) => all.findIndex((r) => r.portalId === ref.portalId && r.channelId === ref.channelId) === i,
    );
    return this.rank(unique, limit);
  }

  /**
   * Classées par score, en alternant les serveurs (une panne de serveur touche tous ses
   * abonnements), puis bornées : les meilleures sources d'un grand groupe passent devant.
   */
  private rank(refs: readonly ChannelRef[], limit: number): ChannelRef[] {
    const ranked = rankSources(
      refs.map((ref) => ({
        ref: { portalId: ref.portalId, channelId: ref.channelId },
        score: this.health.health(ref).score,
      })),
    );
    return diversifyHosts(ranked, (r) => this.hostOf(r.ref.portalId))
      .slice(0, limit)
      .map((r) => r.ref);
  }

  private hostOf(portalId: string): string {
    try {
      return new URL(this.registry.get(portalId).origin).host;
    } catch {
      // Portail retiré entre-temps : considéré comme un serveur à part.
      return portalId;
    }
  }

  /** Santé de toutes les sources connues d'une chaîne (diagnostic, indicateur de santé). */
  async channelHealth(ref: ChannelRef): Promise<ChannelHealthDto> {
    if (
      ref.portalId !== ALL_PORTALS_ID &&
      (await this.catalog.channel(ref.portalId, ref.channelId)) === null
    ) {
      throw notFound('chaîne');
    }
    // Diagnostic : toutes les sources, y compris celles que la lecture n'essaierait pas.
    const refs = await this.candidates({ ...ref, fallbacks: [] }, Number.POSITIVE_INFINITY);
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
   * Playlist du relais. Avec `waitForSeq` (rechargement bloquant, `_HLS_msn`, et
   * `_HLS_part` en LL-HLS), la réponse attend que ce segment ou cette partie paraisse : le
   * lecteur le reçoit à l'instant de sa publication.
   */
  async playlist(
    user: AuthUser,
    sessionId: string,
    waitForSeq?: number,
    waitForPart?: number,
  ): Promise<string> {
    const session = this.owned(user, sessionId);
    if (!session.attached) {
      session.attached = true;
      session.log.info({ state: session.relay.state }, 'lecteur rattaché au relais');
    }
    this.refreshOutput(session);
    const view = session.view;
    if (waitForSeq !== undefined) {
      // Trop loin dans le futur : le lecteur se trompe (RFC 8216bis : 400).
      if (waitForSeq > view.nextSeq + MAX_BLOCKING_AHEAD_SEGMENTS) {
        throw new ApiError(400, 'bad_request', 'segment demandé trop loin dans le futur');
      }
      if (session.relay.state !== 'closed') {
        await view.waitFor(waitForSeq, session.lowLatency ? waitForPart : undefined, BLOCKING_RELOAD_MAX_MS);
      }
      session.lastSeen = Date.now();
    }
    return session.view.playlist(segmentUri, session.lowLatency);
  }

  recordStats(user: AuthUser, sessionId: string, stats: PlaybackStatsRequest): void {
    this.owned(user, sessionId);
    this.relays.metrics.watchSeconds.inc({}, stats.watchedMs / 1000);
    this.relays.metrics.stallSeconds.inc({}, stats.stalledMs / 1000);
  }

  /**
   * Segment, ou partie de segment (LL-HLS). La partie annoncée en indice de préchargement
   * (PRELOAD-HINT) n'existe pas encore : la réponse attend sa publication.
   */
  async segment(user: AuthUser, sessionId: string, seq: number, part?: number): Promise<Buffer> {
    const session = this.owned(user, sessionId);
    const view = session.view;
    let data = part === undefined ? view.segment(seq) : view.part(seq, part);
    if (data === undefined && part !== undefined && seq === view.nextSeq) {
      await view.waitFor(seq, part, BLOCKING_RELOAD_MAX_MS);
      session.lastSeen = Date.now();
      data = view.part(seq, part);
    }
    if (data === undefined) throw notFound('segment');
    this.relays.metrics.bytesOut.inc({}, data.length);
    return data;
  }

  stop(user: AuthUser, sessionId: string): void {
    this.close(this.owned(user, sessionId), 'arrêtée par le client');
  }

  private close(session: ViewerSession, reason: string): void {
    if (!this.sessions.delete(session.id)) return;
    for (const output of session.held.values()) this.transcodes?.release(session.relay, output);
    session.held.clear();
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

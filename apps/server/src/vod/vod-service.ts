import { randomBytes } from 'node:crypto';
import { StalkerError } from '@lumen/core/stalker';
import {
  ALL_PORTALS_ID,
  type QualityProfile,
  type VodItemRef,
  type VodPlaybackDto,
  type VodPlayRequestParsed,
} from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { MergeService } from '../catalog/merge-service.js';
import type { VodCatalogService } from '../catalog/vod-catalog-service.js';
import { ApiError, fromStalker, notFound } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { SegmenterOptions } from '../relay/segmenter.js';
import type { UpstreamLink } from '../relay/upstream.js';
import type { AuthUser } from '../store/auth-store.js';
import { SOFTWARE_ENCODER } from '../transcode/encoders.js';
import type { TranscodeOptions } from '../transcode/ffmpeg-args.js';
import { type OutputPlan, planOutput } from '../transcode/plan.js';
import type { TranscodeService } from '../transcode/transcode-service.js';
import { type MediaInfo, defaultAudioTrack, probeMedia } from './probe.js';
import type { VodSourceProxy } from './source-proxy.js';
import type { VodSegmentsOptions } from './vod-segments.js';
import { type CueBatch, VodSession } from './vod-session.js';

const SESSION_ID_BYTES = 16;
const MS_PER_S = 1000;
/** Propriétés d'un fichier gardées ce temps : relancer un film (saut, piste) ne le relit pas. */
const PROBE_CACHE_TTL_MS = 60 * 60_000;
const PROBE_CACHE_MAX_ENTRIES = 200;
/**
 * Pistes de sous-titres texte extraites au plus par lecture : toutes en même temps, pour
 * changer de langue sans relancer le film. Au-delà (fichiers à vingt langues), les suivantes
 * ne sont pas proposées ; chacune coûte peu, mais une sortie de FFmpeg de plus.
 */
const MAX_TEXT_SUBTITLE_TRACKS = 8;
/** Lectures abandonnées (onglet fermé sans arrêt) cherchées à ce rythme. */
const SWEEP_INTERVAL_MS = 10_000;

export interface VodPlaybackOptions {
  ffmpegPath: string;
  ffprobePath: string;
  maxSessions: number;
  maxSessionsPerUser: number;
  /** Sans requête du lecteur pendant ce délai, la lecture est fermée. */
  idleTtlMs: number;
  probeTimeoutMs: number;
  startTimeoutMs: number;
  segmenter: SegmenterOptions;
  segments: VodSegmentsOptions;
  transcode: TranscodeOptions;
}

export interface VodPlaybackDeps {
  vod: VodCatalogService;
  /** Chaînes (archive disponible ?) et fusion (« Tous les portails ») : pour le rattrapage. */
  catalog: CatalogService;
  merge: MergeService;
  registry: PortalRegistry;
  proxy: VodSourceProxy;
  transcodes: TranscodeService | null;
  log: FastifyBaseLogger;
}

type PlayRequest = VodPlayRequestParsed;

interface ResolvedItem {
  /** Clé du fichier (propriétés en cache). */
  key: string;
  link: () => Promise<UpstreamLink>;
  /**
   * Durée connue d'avance (émission archivée : celle du guide). Un flux d'archive n'a souvent
   * ni taille ni durée lisibles ; le guide, lui, sait.
   */
  durationS?: number;
}

/** Programme cherché dans le guide autour de son début annoncé (horloges des portails décalées). */
const ARCHIVE_MATCH_TOLERANCE_MS = 60_000;

const playlistUrl = (sessionId: string): string => `/api/vod/sessions/${sessionId}/playlist.m3u8`;
export const vodSegmentUri = (seq: number): string => `${seq}.ts`;

/**
 * Lectures de films et d'épisodes. Chacune a son FFmpeg et sa connexion au portail (par le
 * relais local) ; un saut au-delà de ce qui est chargé, ou un changement de piste audio,
 * ouvre une nouvelle lecture qui remplace l'ancienne.
 */
export class VodPlaybackService {
  private readonly sessions = new Map<string, VodSession>();
  private readonly probes = new Map<string, { at: number; info: Promise<MediaInfo> }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly options: VodPlaybackOptions,
    private readonly deps: VodPlaybackDeps,
  ) {
    this.sweeper = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async start(user: AuthUser, request: PlayRequest): Promise<VodPlaybackDto> {
    // L'ancienne lecture d'abord : beaucoup de portails n'acceptent qu'une connexion par abonnement.
    if (request.replaces !== undefined) {
      const old = this.sessions.get(request.replaces);
      if (old?.userId === user.id) old.close();
    }
    const mine = [...this.sessions.values()]
      .filter((s) => s.userId === user.id)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= this.options.maxSessionsPerUser) mine.shift()?.close();
    if (this.sessions.size >= this.options.maxSessions) {
      throw new ApiError(503, 'too_many_streams', 'le serveur lit déjà le maximum de films à la fois');
    }

    const item = await this.resolveItem(request.item);
    let initial: UpstreamLink;
    try {
      initial = await item.link();
    } catch (err) {
      throw err instanceof StalkerError ? fromStalker(err) : err;
    }
    const source = this.deps.proxy.open(item.link, initial);
    let release: (() => void) | null = null;
    try {
      const info = await this.probe(item.key, source.url);
      const audioIndex =
        request.audioTrack !== undefined && request.audioTrack < info.audio.length
          ? request.audioTrack
          : defaultAudioTrack(info);
      const choice = this.plan(info, audioIndex, request);
      release = choice.release;
      const burn = this.burn(info, request.burnSubtitle, choice.plan);
      if (burn.release !== null) release = burn.release;
      const plan = burn.plan ?? choice.plan;
      const textSubtitles = info.subtitles
        .filter((t) => t.kind === 'text')
        .slice(0, MAX_TEXT_SUBTITLE_TRACKS)
        .map((t) => t.index);
      const encoder = (await this.deps.transcodes?.encoderReady()) ?? SOFTWARE_ENCODER;
      const session = new VodSession(
        {
          id: randomBytes(SESSION_ID_BYTES).toString('hex'),
          userId: user.id,
          info,
          plan,
          startS: request.startS,
          audioIndex,
          textSubtitles,
          burnSubtitle: burn.index,
        },
        source,
        {
          ffmpegPath: this.options.ffmpegPath,
          encoder,
          transcode: this.options.transcode,
          segmenter: this.options.segmenter,
          segments: this.options.segments,
          startTimeoutMs: this.options.startTimeoutMs,
          log: this.deps.log,
        },
      );
      const releaseSlot = release;
      release = null;
      session.onClose = () => {
        releaseSlot?.();
        this.sessions.delete(session.id);
      };
      this.sessions.set(session.id, session);
      session.start();
      try {
        await session.ready();
      } catch (err) {
        session.close();
        throw new ApiError(
          502,
          'vod_unavailable',
          `lecture impossible : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
        );
      }
      return {
        sessionId: session.id,
        playlistUrl: playlistUrl(session.id),
        durationS: item.durationS ?? info.durationS,
        startS: request.startS,
        audioTracks: info.audio.map((t) => ({ index: t.index, language: t.language, label: t.label })),
        audioTrack: audioIndex,
        transcode: { video: plan.video !== 'copy', audio: plan.audio !== 'copy' },
        quality: choice.quality,
        subtitleTracks: info.subtitles
          .filter((t) => t.kind === 'image' || textSubtitles.includes(t.index))
          .map((t) => ({ index: t.index, language: t.language, label: t.label, kind: t.kind })),
        burnedSubtitle: burn.index,
        notice: burn.notice,
      };
    } catch (err) {
      release?.();
      source.close();
      throw err;
    }
  }

  /**
   * Plan de conversion : copie autant que possible. Une qualité réduite est une préférence,
   * jamais une condition pour voir l'image : sans place pour la produire, le film part en
   * qualité source.
   */
  private plan(
    info: MediaInfo,
    audioIndex: number,
    request: PlayRequest,
  ): { plan: OutputPlan; quality: QualityProfile; release: (() => void) | null } {
    const codecs = {
      videoCodec: info.video?.codec ?? null,
      audioCodec: info.audio[audioIndex]?.codec ?? null,
    };
    let quality = request.quality;
    let plan = planOutput(codecs, request.caps, quality);
    const transcodes = this.deps.transcodes;
    if (plan.video === 'copy' && plan.audio === 'copy') return { plan, quality, release: null };
    if (transcodes === null) {
      if (quality !== 'source') {
        quality = 'source';
        plan = planOutput(codecs, request.caps, quality);
        if (plan.video === 'copy' && plan.audio === 'copy') return { plan, quality, release: null };
      }
      throw new ApiError(
        415,
        'unsupported_codec',
        'ce navigateur ne lit pas le format de ce film, et la conversion est désactivée',
      );
    }
    if (plan.video === 'copy') return { plan, quality, release: null };
    try {
      return { plan, quality, release: transcodes.reserveVideo() };
    } catch (err) {
      if (quality === 'source') throw err;
      quality = 'source';
      plan = planOutput(codecs, request.caps, quality);
      return { plan, quality, release: plan.video === 'copy' ? null : transcodes.reserveVideo() };
    }
  }

  /**
   * Sous-titres en images à incruster : l'image doit être convertie. Déjà convertie, rien ne
   * change ; sinon il faut une place de conversion. Sans place, le film part quand même,
   * sans incrustation, avec un message : voir l'image passe avant les sous-titres.
   */
  private burn(
    info: MediaInfo,
    requested: number | undefined,
    plan: OutputPlan,
  ): { index: number | null; plan: OutputPlan | null; release: (() => void) | null; notice: string | null } {
    const none = { index: null, plan: null, release: null, notice: null };
    const track = info.subtitles.find((t) => t.index === requested && t.kind === 'image');
    if (track === undefined || info.video === null) return none;
    if (plan.video === 'h264') return { ...none, index: track.index };
    const transcodes = this.deps.transcodes;
    if (transcodes === null) {
      return {
        ...none,
        notice: 'Sous-titres en images indisponibles : la conversion est désactivée sur ce serveur.',
      };
    }
    try {
      const release = transcodes.reserveVideo();
      return {
        index: track.index,
        plan: { ...plan, video: 'h264', key: `h264+${plan.audio}` },
        release,
        notice: null,
      };
    } catch {
      return {
        ...none,
        notice:
          'Sous-titres en images indisponibles pour l’instant : le serveur convertit déjà le maximum de flux.',
      };
    }
  }

  /** Répliques d'une piste de sous-titres texte de cette lecture. */
  subtitleCues(user: AuthUser, sessionId: string, index: number, after: number): CueBatch {
    const batch = this.owned(user, sessionId).subtitleCues(index, after);
    if (batch === null) throw notFound('sous-titres');
    return batch;
  }

  private async resolveItem(ref: VodItemRef): Promise<ResolvedItem> {
    if (ref.kind === 'archive') return this.resolveArchive(ref);
    const portal = this.deps.registry.get(ref.portalId);
    const { client } = portal.provider;
    const asUpstream = async (
      link: Promise<{ url: string; format: UpstreamLink['format'] }>,
    ): Promise<UpstreamLink> => {
      const l = await link;
      return { url: l.url, format: l.format, userAgent: portal.userAgent };
    };
    if (ref.kind === 'movie') {
      const movie = await this.deps.vod.movie(ref.portalId, ref.movieId);
      return {
        key: `m:${ref.portalId}:${ref.movieId}`,
        link: () => asUpstream(client.createVodLink(movie.cmd)),
      };
    }
    const episode = await this.deps.vod.episode(ref.portalId, ref.seriesId, ref.seasonId, ref.episodeId);
    return {
      key: `e:${ref.portalId}:${ref.seriesId}:${ref.seasonId}:${ref.episodeId}`,
      link: () => asUpstream(client.createEpisodeLink(episode.cmd)),
    };
  }

  /**
   * Émission archivée : la chaîne (ou, vue « Tous les portails », la première de ses sources
   * qui garde une archive), puis le programme dans son guide, marqué « archivé » par le portail.
   */
  private async resolveArchive(ref: Extract<VodItemRef, { kind: 'archive' }>): Promise<ResolvedItem> {
    const sources =
      ref.portalId === ALL_PORTALS_ID
        ? (this.deps.merge.members(ref.channelId) ?? [])
        : [{ portalId: ref.portalId, channelId: ref.channelId }];
    for (const source of sources) {
      const channel = await this.deps.catalog.channel(source.portalId, source.channelId);
      if (channel === null || channel.archiveHours <= 0) continue;
      const portal = this.deps.registry.get(source.portalId);
      const programmes = await portal.provider
        .getEpg(source.channelId, {
          from: ref.start - ARCHIVE_MATCH_TOLERANCE_MS,
          to: ref.end + ARCHIVE_MATCH_TOLERANCE_MS,
        })
        .catch(() => []);
      const programme = programmes
        .filter((p) => p.catchup !== null && Math.abs(p.start - ref.start) <= ARCHIVE_MATCH_TOLERANCE_MS)
        .sort((a, b) => Math.abs(a.start - ref.start) - Math.abs(b.start - ref.start))[0];
      const catchup = programme?.catchup;
      if (programme === undefined || catchup == null) continue;
      return {
        key: `a:${source.portalId}:${source.channelId}:${programme.start}`,
        link: async () => {
          const link = await portal.provider.resolveStream(catchup);
          return { url: link.url, format: link.format, userAgent: portal.userAgent };
        },
        durationS: (programme.end - programme.start) / MS_PER_S,
      };
    }
    throw new ApiError(404, 'not_found', 'cette émission n’est pas (ou plus) dans l’archive du portail');
  }

  private probe(key: string, url: string): Promise<MediaInfo> {
    const now = Date.now();
    const hit = this.probes.get(key);
    if (hit !== undefined && now - hit.at <= PROBE_CACHE_TTL_MS) return hit.info;
    const info = probeMedia(this.options.ffprobePath, url, this.options.probeTimeoutMs).catch(
      (err: unknown) => {
        this.probes.delete(key);
        throw new ApiError(
          502,
          'vod_unavailable',
          `fichier illisible : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
        );
      },
    );
    this.probes.delete(key);
    this.probes.set(key, { at: now, info });
    for (const old of this.probes.keys()) {
      if (this.probes.size <= PROBE_CACHE_MAX_ENTRIES) break;
      this.probes.delete(old);
    }
    return info;
  }

  private owned(user: AuthUser, sessionId: string): VodSession {
    const session = this.sessions.get(sessionId);
    // Même réponse pour « inexistante » et « à quelqu'un d'autre » : rien à deviner.
    if (session?.userId !== user.id) throw notFound('lecture');
    return session;
  }

  playlist(user: AuthUser, sessionId: string): string {
    return this.owned(user, sessionId).playlist(vodSegmentUri);
  }

  segment(user: AuthUser, sessionId: string, seq: number): Buffer {
    const data = this.owned(user, sessionId).segment(seq);
    if (data === null) throw notFound('segment');
    return data;
  }

  stop(user: AuthUser, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.userId === user.id) session.close();
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) if (now - s.lastSeen > this.options.idleTtlMs) s.close();
  }

  closeAll(): void {
    clearInterval(this.sweeper);
    for (const s of [...this.sessions.values()]) s.close();
  }
}

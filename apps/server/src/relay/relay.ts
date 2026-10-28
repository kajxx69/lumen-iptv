import { randomUUID } from 'node:crypto';
import type { HealthEvent } from '@lumen/core/resilience';
import type { FastifyBaseLogger } from 'fastify';
import type { ContentAnalyzer } from '../resilience/content-analyzer.js';
import { type FailoverOptions, FailoverPolicy } from './failover.js';
import type { TranscodedOutput } from '../transcode/transcoded-output.js';
import { MediaOutput, type MediaOutputOptions } from './media-output.js';
import { MPEG_CLOCK_HZ, type ProgramStreams, timestampDelta } from './mpegts.js';
import type { SegmentUri } from './playlist.js';
import type { RelayMetrics } from './relay-metrics.js';
import type { SegmentCache } from './segment-cache.js';
import type { RelaySegment } from './segment-window.js';
import type { SegmentDraft, SegmenterOptions } from './segmenter.js';
import { type UpstreamLink, type UpstreamOptions, UpstreamError, readUpstream, sleep } from './upstream.js';

/** Une source possible pour la chaîne relayée : un couple (portail, chaîne). */
export interface RelaySource {
  /** Identifiant interne `portail:chaîne`, sans secret : seul repère dans les journaux. */
  id: string;
  portalId: string;
  channelId: string;
  /** create_link : un lien neuf à chaque connexion (les liens amont expirent vite). */
  resolve(): Promise<UpstreamLink>;
}

/** Détection de panne au-delà du réseau (PROJECT.md, moteur de résilience §2). */
export interface DetectionOptions {
  /** Octets reçus mais horodatages figés depuis ce délai : flux gelé (cible : 2,5 s). */
  freezeMs: number;
  /** Image noire ou silence cumulés au-delà : panne de contenu (cible : 10 s). */
  contentFailureS: number;
  /** Débit reçu sous cette part du débit du flux : source trop lente pour tenir le direct. */
  slowRatio: number;
  /** Fenêtre de mesure du débit reçu. */
  slowWindowMs: number;
}

export interface RelayOptions {
  /** Profondeur du tampon glissant (PROJECT.md : 30 s par défaut, 120 s au plus). */
  bufferS: number;
  /** EXT-X-TARGETDURATION, fixe pour toute la vie du relais. */
  targetDurationS: number;
  /** HOLD-BACK annoncé aux lecteurs : retard visé sur le direct au démarrage. */
  holdBackS: number;
  /** PART-HOLD-BACK : retard visé en « direct au plus près » (LL-HLS). */
  partHoldBackS: number;
  segmenter: SegmenterOptions;
  upstream: UpstreamOptions;
  failover: FailoverOptions;
  /** Sans nouveau segment depuis ce délai, la connexion amont est jugée bloquée. */
  stallTimeoutMs: number;
  detection: DetectionOptions;
}

export interface RelayDeps {
  cache: SegmentCache;
  metrics: RelayMetrics;
  log: FastifyBaseLogger;
  /** Événements de santé de chaque source (score, classement des sources). */
  health?: (source: RelaySource, event: HealthEvent) => void;
  /** Analyse d'image et de son ; absente, la détection d'écran noir est désactivée. */
  content?: ContentAnalyzer;
}

export type RelayState = 'starting' | 'live' | 'recovering' | 'closed';

export class RelayUnavailableError extends Error {
  override readonly name = 'RelayUnavailableError';
}

/** Fréquence de vérification du blocage amont : bien plus fine que le délai lui-même. */
const STALL_CHECK_INTERVAL_MS = 250;

/** Les octets doivent être récents pour parler de gel (sinon c'est un blocage réseau, géré à part). */
const FREEZE_BYTES_RECENT_MS = 1000;
/** Lissage du débit attendu (moyenne mobile exponentielle sur les segments publiés). */
const BITRATE_SMOOTHING = 0.2;
/** Part d'un segment noire ou muette pour le compter comme « mort ». */
const DEAD_SEGMENT_RATIO = 0.9;

type SwitchReason = 'switch' | 'frozen' | 'content' | 'slow';
type ConnectionEnd = 'ended' | 'failed' | 'stalled' | 'closed' | SwitchReason;
const SWITCH_REASONS = new Set<ConnectionEnd>(['switch', 'frozen', 'content', 'slow']);

/**
 * Relais d'une chaîne : une connexion amont, partagée par tous ses spectateurs, recopiée
 * dans un tampon glissant et republiée sous une playlist HLS qui ne change jamais d'URL.
 * Les changements de source n'y apparaissent que comme une discontinuité.
 *
 * Limite assumée (PROJECT.md §9) : si toutes les sources restent muettes plus longtemps que
 * l'avance dont dispose le lecteur, la lecture s'arrête. Le relais continue alors de servir
 * la dernière playlist et reprend dès qu'une source répond ; il ne peut pas inventer d'images.
 */
export class Relay {
  readonly id = randomUUID();
  /** Sortie directe : le flux amont tel quel, découpé. */
  readonly output: MediaOutput;
  /** Sorties transcodées, par plan (voir transcode/plan) : nourries du même flux amont. */
  private readonly transcodedOutputs = new Map<string, TranscodedOutput>();
  private readonly policy: FailoverPolicy;
  private readonly sources: RelaySource[];
  private readonly closeController = new AbortController();
  private readonly openedAt = Date.now();
  private readonly log: FastifyBaseLogger;
  private connection: AbortController | null = null;
  private connectionEnd: ConnectionEnd | null = null;
  private current: RelaySource;
  private lastSegmentAt = 0;
  private published = 0;
  private forcedCutsSeen = 0;
  private outageStartedAt: number | null = null;
  private waiters: { resolve: () => void; reject: (err: Error) => void }[] = [];
  private failure: Error | null = null;
  /** Débit du flux (octets/s de média), appris sur les segments publiés. */
  private expectedBytesPerS: number | null = null;
  /** Octets reçus récemment, pour mesurer le débit réel de la source. */
  private arrivals: { at: number; bytes: number }[] = [];
  private lastBytesAt = 0;
  private connectionOpenedAt = 0;
  /**
   * Début (horodatage du flux) de la série de segments noirs ou muets de la source en cours ;
   * null si le dernier segment jugé était vivant. Un segment que l'analyse n'a pas pu juger
   * (processeur chargé) n'interrompt pas la série : la panne se mesure au temps du flux, pas
   * au nombre de segments analysés.
   */
  private deadSinceTs: number | null = null;
  viewers = 0;
  idleSince: number | null = null;

  constructor(
    readonly key: string,
    sources: readonly RelaySource[],
    private readonly options: RelayOptions,
    private readonly deps: RelayDeps,
  ) {
    const first = sources[0];
    if (first === undefined) throw new Error('relais sans source');
    this.sources = [...sources];
    this.current = first;
    this.log = deps.log.child({ relay: this.id });
    this.output = new MediaOutput(
      this.id,
      options,
      deps.cache,
      () => this.current.id,
      (segment, draft) => {
        this.onSegment(segment, draft);
      },
    );
    this.policy = new FailoverPolicy(() => this.sources.length, options.failover);
  }

  start(): void {
    this.log.info({ source: this.current.id, sources: this.sources.length }, 'relais ouvert');
    void this.run();
  }

  get state(): RelayState {
    if (this.closeController.signal.aborted) return 'closed';
    if (this.published === 0) return 'starting';
    return this.outageStartedAt === null ? 'live' : 'recovering';
  }

  get bufferedBytes(): number {
    return this.output.bytes;
  }

  /** Indicateur de source et de santé pour le lecteur. */
  get status(): { activeSource: number; activePortalId: string; sourceCount: number; bufferedS: number } {
    return {
      activeSource: Math.max(0, this.sources.indexOf(this.current)),
      activePortalId: this.current.portalId,
      sourceCount: this.sources.length,
      bufferedS: this.output.window.bufferedS,
    };
  }

  get portalIds(): string[] {
    return this.sources.map((s) => s.portalId);
  }

  /** Ajoute des sources de secours (un second spectateur peut en connaître d'autres). */
  addSources(sources: readonly RelaySource[]): void {
    for (const s of sources) if (!this.sources.some((x) => x.id === s.id)) this.sources.push(s);
  }

  /** Résolu dès qu'un segment est disponible ; rejeté si toutes les sources ont échoué. */
  ready(timeoutMs: number): Promise<void> {
    if (this.published > 0) return Promise.resolve();
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RelayUnavailableError('aucun segment dans le délai de démarrage'));
      }, timeoutMs);
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  playlist(uri: SegmentUri, lowLatency = false): string {
    return this.output.playlist(uri, lowLatency);
  }

  /** Codecs du flux amont en cours (connus dès la PMT) ; null avant. */
  get programStreams(): ProgramStreams | null {
    return this.output.segmenter.programStreams;
  }

  get mediaOptions(): MediaOutputOptions {
    return this.options;
  }

  get currentSourceId(): string {
    return this.current.id;
  }

  transcoded(key: string): TranscodedOutput | undefined {
    return this.transcodedOutputs.get(key);
  }

  /** Branche une sortie transcodée, amorcée avec le flux récent : elle démarre sans attendre. */
  attachTranscoded(output: TranscodedOutput): void {
    this.transcodedOutputs.set(output.key, output);
    output.start(this.output.recentStream(), this.programStreams);
  }

  detachTranscoded(key: string): void {
    this.transcodedOutputs.delete(key);
  }

  /** Rupture du flux (nouvelle source, discontinuité amont) : toutes les sorties la marquent. */
  private breakStreams(): void {
    this.output.segmenter.breakStream();
    for (const t of this.transcodedOutputs.values()) t.restart();
  }

  /** Prochain numéro de segment (celui que publiera la source). */
  get nextSeq(): number {
    return this.output.nextSeq;
  }

  /** Rechargement bloquant : voir MediaOutput.waitFor. */
  waitFor(seq: number, part: number | undefined, timeoutMs: number): Promise<void> {
    if (this.isClosed()) return Promise.resolve();
    return this.output.waitFor(seq, part, timeoutMs);
  }

  segment(seq: number): Buffer | undefined {
    return this.output.segment(seq);
  }

  part(seq: number, index: number): Buffer | undefined {
    return this.output.part(seq, index);
  }

  /** Bascule immédiate vers la source suivante (gel, écran noir, débit, tests). */
  requestSwitch(reason: SwitchReason = 'switch'): void {
    if (this.connection === null) return;
    this.connectionEnd ??= reason;
    this.connection.abort();
  }

  private emit(source: RelaySource, event: HealthEvent): void {
    this.deps.health?.(source, event);
  }

  close(reason: string): void {
    if (this.closeController.signal.aborted) return;
    this.closeController.abort();
    this.connectionEnd = 'closed';
    this.connection?.abort();
    this.output.close();
    this.deps.content?.forget(this.id);
    for (const t of this.transcodedOutputs.values()) t.close();
    this.transcodedOutputs.clear();
    this.rejectWaiters(new RelayUnavailableError('relais fermé'));
    this.log.info({ reason, segments: this.published }, 'relais fermé');
  }

  private isClosed(): boolean {
    return this.closeController.signal.aborted;
  }

  private async run(): Promise<void> {
    const closed = this.closeController.signal;
    while (!this.isClosed()) {
      const end = await this.connect(this.current);
      if (this.isClosed()) break;
      const produced = end.produced;
      const source = this.current;
      // Le morceau en cours est publié s'il est utile ; la suite portera une discontinuité.
      this.breakStreams();
      this.deadSinceTs = null;
      this.arrivals = [];
      if (end.kind !== 'switch' && end.kind !== 'ended')
        this.deps.metrics.upstreamFailures.inc({ kind: end.kind });
      const at = Date.now();
      if (end.kind === 'frozen') this.emit(source, { kind: 'freeze', at });
      else if (end.kind === 'content') this.emit(source, { kind: 'content', at });
      else if (end.kind === 'slow') this.emit(source, { kind: 'segment', at, ok: false });
      if (end.kind !== 'switch' && end.kind !== 'closed') this.emit(source, { kind: 'down', at });
      // Début de panne (pour la mesure de reprise) : après le segment final éventuel ci-dessus.
      if (this.published > 0) this.outageStartedAt ??= Date.now();

      const bufferedAhead =
        this.published > 0 && Date.now() - this.lastSegmentAt < this.options.bufferS * 1000;
      const decision = this.policy.next({
        produced,
        bufferedAhead,
        switchRequested: SWITCH_REASONS.has(end.kind),
      });
      if (this.published === 0 && this.policy.exhausted) {
        this.failure = new RelayUnavailableError('aucune source ne répond');
        this.rejectWaiters(this.failure);
      }
      const next = this.sources[decision.source] ?? this.current;
      if (next !== this.current) this.deps.metrics.switches.inc({ reason: end.kind });
      this.log.info(
        {
          end: end.kind,
          produced,
          decision: decision.reason,
          delayMs: decision.delayMs,
          from: this.current.id,
          to: next.id,
        },
        'connexion amont terminée',
      );
      this.current = next;
      if (decision.delayMs > 0) await sleep(decision.delayMs, closed).catch(() => undefined);
    }
  }

  private async connect(source: RelaySource): Promise<{ kind: ConnectionEnd; produced: boolean }> {
    const controller = new AbortController();
    this.connection = controller;
    this.connectionEnd = null;
    const before = this.published;
    const openedAt = Date.now();
    this.connectionOpenedAt = openedAt;
    let progressAt = openedAt;
    // Gel : les horodatages n'avancent plus alors que les octets arrivent toujours.
    const advancesAtStart = this.output.segmenter.stats.timestampAdvances;
    let advances = advancesAtStart;
    let advancedAt = openedAt;
    const detection = this.options.detection;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (this.published > before) progressAt = Math.max(progressAt, this.lastSegmentAt);
      if (now - progressAt > this.options.stallTimeoutMs) {
        this.connectionEnd ??= 'stalled';
        controller.abort();
        return;
      }
      const seen = this.output.segmenter.stats.timestampAdvances;
      if (seen !== advances) {
        advances = seen;
        advancedAt = now;
      } else if (
        seen > advancesAtStart &&
        now - advancedAt > detection.freezeMs &&
        now - this.lastBytesAt < FREEZE_BYTES_RECENT_MS
      ) {
        this.log.warn({ source: source.id, ms: now - advancedAt }, 'flux gelé : horodatages figés');
        this.connectionEnd ??= 'frozen';
        controller.abort();
        return;
      }
      if (this.isTooSlow(now, openedAt)) {
        this.log.warn({ source: source.id }, 'source trop lente pour tenir le direct');
        this.connectionEnd ??= 'slow';
        controller.abort();
      }
    }, STALL_CHECK_INTERVAL_MS);
    watchdog.unref();
    let kind: ConnectionEnd = 'ended';
    try {
      let link: UpstreamLink;
      const resolveStart = Date.now();
      try {
        link = await source.resolve();
        this.emit(source, { kind: 'resolve', at: Date.now(), ms: Date.now() - resolveStart, ok: true });
      } catch {
        this.deps.metrics.resolveFailures.inc();
        this.emit(source, { kind: 'resolve', at: Date.now(), ms: Date.now() - resolveStart, ok: false });
        throw new UpstreamError('network', 'create_link en échec');
      }
      if (controller.signal.aborted) throw new UpstreamError('network', 'abandon');
      this.deps.metrics.activeUpstreams++;
      const fetchStart = Date.now();
      let firstByte = true;
      try {
        await readUpstream(
          link,
          {
            data: (bytes) => {
              const now = Date.now();
              if (firstByte) {
                firstByte = false;
                this.emit(source, { kind: 'firstByte', at: now, ms: now - fetchStart });
              }
              this.lastBytesAt = now;
              this.arrivals.push({ at: now, bytes: bytes.length });
              this.deps.metrics.bytesIn.inc({}, bytes.length);
              this.output.segmenter.push(bytes);
              const streams = this.programStreams;
              for (const t of this.transcodedOutputs.values()) t.write(bytes, streams);
            },
            discontinuity: () => {
              this.breakStreams();
            },
            skipped: () => {
              this.deps.metrics.skippedSegments.inc();
              this.breakStreams();
            },
          },
          controller.signal,
          this.options.upstream,
        );
      } finally {
        this.deps.metrics.activeUpstreams--;
      }
    } catch (err) {
      // Fixé par un abandon volontaire (bascule, blocage, fermeture) ; sinon, vraie panne.
      kind = this.endReason() ?? 'failed';
      if (kind === 'failed') {
        const e = err instanceof UpstreamError ? err : new UpstreamError('network', 'erreur inattendue');
        this.log.warn({ source: source.id, kind: e.kind, status: e.status }, 'source amont en panne');
      }
    } finally {
      clearInterval(watchdog);
      this.connection = null;
    }
    return { kind, produced: this.published > before };
  }

  private endReason(): ConnectionEnd | null {
    return this.connectionEnd;
  }

  /**
   * Source trop lente : sur la dernière fenêtre, elle livre bien moins d'octets que le flux
   * n'en consomme. Seulement s'il existe une autre source (sinon, mieux vaut un flux lent
   * que pas de flux) et une fois le débit du flux connu.
   */
  private isTooSlow(now: number, openedAt: number): boolean {
    const d = this.options.detection;
    const expected = this.expectedBytesPerS;
    if (expected === null || this.sources.length < 2 || now - openedAt < d.slowWindowMs) return false;
    const since = now - d.slowWindowMs;
    this.arrivals = this.arrivals.filter((a) => a.at >= since);
    const received = this.arrivals.reduce((n, a) => n + a.bytes, 0);
    return received < d.slowRatio * expected * (d.slowWindowMs / 1000);
  }

  /** Image noire ou silence : mesurés sur le temps du flux, depuis le premier segment mort. */
  private judgeContent(sourceId: string, data: Buffer, durationS: number, startTs: number): void {
    const analyzer = this.deps.content;
    // Relais sans spectateur (délai de grâce) : personne à protéger, l'analyse sert aux autres.
    if (analyzer === undefined || this.viewers === 0) return;
    void analyzer.analyze(data, durationS, this.id).then((v) => {
      // Segment non jugé (analyse saturée) ou source déjà quittée : on ne conclut rien.
      if (v === null || sourceId !== this.current.id || this.isClosed()) return;
      const dead =
        (v.hasVideo && v.blackS >= DEAD_SEGMENT_RATIO * durationS) ||
        (v.hasAudio && v.silentS >= DEAD_SEGMENT_RATIO * durationS);
      if (!dead) {
        this.deadSinceTs = null;
        return;
      }
      // Verdicts parfois dans le désordre (analyses en parallèle) : on garde le début le plus ancien.
      if (this.deadSinceTs === null || timestampDelta(startTs, this.deadSinceTs) > 0)
        this.deadSinceTs = startTs;
      const deadS = timestampDelta(this.deadSinceTs, startTs) / MPEG_CLOCK_HZ + durationS;
      if (deadS < this.options.detection.contentFailureS) return;
      this.log.warn({ source: sourceId, seconds: Math.round(deadS) }, 'image noire ou silence prolongé');
      this.deadSinceTs = null;
      if (this.sources.length > 1) this.requestSwitch('content');
      else this.emit(this.current, { kind: 'content', at: Date.now() });
    });
  }

  private onSegment(segment: RelaySegment, draft: SegmentDraft): void {
    const now = Date.now();
    if (this.lastSegmentAt < this.connectionOpenedAt) this.emit(this.current, { kind: 'up', at: now });
    this.lastSegmentAt = now;
    this.published++;
    if (draft.durationS > 0) {
      const bytesPerS = draft.data.length / draft.durationS;
      this.expectedBytesPerS =
        this.expectedBytesPerS === null
          ? bytesPerS
          : this.expectedBytesPerS + BITRATE_SMOOTHING * (bytesPerS - this.expectedBytesPerS);
      this.emit(this.current, {
        kind: 'segment',
        at: now,
        ok: true,
        bitrateKbps: Math.round((bytesPerS * 8) / 1000),
      });
      this.judgeContent(this.current.id, draft.data, draft.durationS, draft.startTs);
    }
    const m = this.deps.metrics;
    m.segments.inc();
    const forced = this.output.segmenter.stats.forcedCuts - this.forcedCutsSeen;
    if (forced > 0) m.forcedCuts.inc({}, forced);
    this.forcedCutsSeen = this.output.segmenter.stats.forcedCuts;
    if (this.published === 1) {
      m.startupSeconds.observe((now - this.openedAt) / 1000);
      this.log.info({ ms: now - this.openedAt, durationS: segment.durationS }, 'premier segment publié');
    }
    if (this.outageStartedAt !== null) {
      m.recoverySeconds.observe((now - this.outageStartedAt) / 1000);
      this.log.info(
        { ms: now - this.outageStartedAt, source: this.current.id, seq: segment.seq },
        'flux repris',
      );
      this.outageStartedAt = null;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
  }

  private rejectWaiters(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }
}

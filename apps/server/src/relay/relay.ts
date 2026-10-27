import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { type FailoverOptions, FailoverPolicy } from './failover.js';
import { renderPlaylist } from './playlist.js';
import type { RelayMetrics } from './relay-metrics.js';
import type { SegmentCache } from './segment-cache.js';
import { SegmentWindow } from './segment-window.js';
import { type SegmentDraft, type SegmenterOptions, TsSegmenter } from './segmenter.js';
import { type UpstreamLink, type UpstreamOptions, UpstreamError, readUpstream, sleep } from './upstream.js';

/** Une source possible pour la chaîne relayée : un couple (portail, chaîne). */
export interface RelaySource {
  /** Identifiant interne `portail:chaîne`, sans secret : seul repère dans les journaux. */
  id: string;
  portalId: string;
  /** create_link : un lien neuf à chaque connexion (les liens amont expirent vite). */
  resolve(): Promise<UpstreamLink>;
}

export interface RelayOptions {
  /** Profondeur du tampon glissant (PROJECT.md : 30 s par défaut, 120 s au plus). */
  bufferS: number;
  /** EXT-X-TARGETDURATION, fixe pour toute la vie du relais. */
  targetDurationS: number;
  segmenter: SegmenterOptions;
  upstream: UpstreamOptions;
  failover: FailoverOptions;
  /** Sans nouveau segment depuis ce délai, la connexion amont est jugée bloquée. */
  stallTimeoutMs: number;
}

export interface RelayDeps {
  cache: SegmentCache;
  metrics: RelayMetrics;
  log: FastifyBaseLogger;
}

export type RelayState = 'starting' | 'live' | 'recovering' | 'closed';

export class RelayUnavailableError extends Error {
  override readonly name = 'RelayUnavailableError';
}

/** Fréquence de vérification du blocage amont : bien plus fine que le délai lui-même. */
const STALL_CHECK_INTERVAL_MS = 250;

type ConnectionEnd = 'ended' | 'failed' | 'stalled' | 'switch' | 'closed';

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
  private readonly window: SegmentWindow;
  private readonly segmenter: TsSegmenter;
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
    this.window = new SegmentWindow(options.bufferS, (s) => {
      deps.cache.put(this.id, s.seq, s.data);
    });
    this.segmenter = new TsSegmenter(options.segmenter, (d) => {
      this.onSegment(d);
    });
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
    return this.window.bytes;
  }

  /** Indicateur de source et de santé pour le lecteur. */
  get status(): { activeSource: number; sourceCount: number; bufferedS: number } {
    return {
      activeSource: Math.max(0, this.sources.indexOf(this.current)),
      sourceCount: this.sources.length,
      bufferedS: this.window.bufferedS,
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

  playlist(uri: (seq: number) => string): string {
    return renderPlaylist(
      {
        mediaSequence: this.window.mediaSequence,
        discontinuitySequence: this.window.discontinuitySequence,
        segments: this.window.segments,
        targetDurationS: this.options.targetDurationS,
      },
      uri,
    );
  }

  segment(seq: number): Buffer | undefined {
    return this.window.get(seq)?.data ?? this.deps.cache.get(this.id, seq);
  }

  /** Bascule immédiate vers la source suivante (détection de gel, tests). */
  requestSwitch(): void {
    if (this.connection === null) return;
    this.connectionEnd = 'switch';
    this.connection.abort();
  }

  close(reason: string): void {
    if (this.closeController.signal.aborted) return;
    this.closeController.abort();
    this.connectionEnd = 'closed';
    this.connection?.abort();
    this.deps.cache.forget(this.id);
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
      // Le morceau en cours est publié s'il est utile ; la suite portera une discontinuité.
      this.segmenter.breakStream();
      if (end.kind !== 'switch' && end.kind !== 'ended')
        this.deps.metrics.upstreamFailures.inc({ kind: end.kind });
      // Début de panne (pour la mesure de reprise) : après le segment final éventuel ci-dessus.
      if (this.published > 0) this.outageStartedAt ??= Date.now();

      const bufferedAhead =
        this.published > 0 && Date.now() - this.lastSegmentAt < this.options.bufferS * 1000;
      const decision = this.policy.next({ produced, bufferedAhead, switchRequested: end.kind === 'switch' });
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
    let progressAt = Date.now();
    const watchdog = setInterval(() => {
      if (this.published > before) progressAt = Math.max(progressAt, this.lastSegmentAt);
      if (Date.now() - progressAt > this.options.stallTimeoutMs) {
        this.connectionEnd ??= 'stalled';
        controller.abort();
      }
    }, STALL_CHECK_INTERVAL_MS);
    watchdog.unref();
    let kind: ConnectionEnd = 'ended';
    try {
      let link: UpstreamLink;
      try {
        link = await source.resolve();
      } catch {
        this.deps.metrics.resolveFailures.inc();
        throw new UpstreamError('network', 'create_link en échec');
      }
      if (controller.signal.aborted) throw new UpstreamError('network', 'abandon');
      this.deps.metrics.activeUpstreams++;
      try {
        await readUpstream(
          link,
          {
            data: (bytes) => {
              this.deps.metrics.bytesIn.inc({}, bytes.length);
              this.segmenter.push(bytes);
            },
            discontinuity: () => {
              this.segmenter.breakStream();
            },
            skipped: () => {
              this.deps.metrics.skippedSegments.inc();
              this.segmenter.breakStream();
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

  private onSegment(draft: SegmentDraft): void {
    const now = Date.now();
    const segment = this.window.append({ ...draft, sourceId: this.current.id }, now);
    this.lastSegmentAt = now;
    this.published++;
    const m = this.deps.metrics;
    m.segments.inc();
    const forced = this.segmenter.stats.forcedCuts - this.forcedCutsSeen;
    if (forced > 0) m.forcedCuts.inc({}, forced);
    this.forcedCutsSeen = this.segmenter.stats.forcedCuts;
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

import { renderPlaylist, type SegmentUri } from '../relay/playlist.js';
import type { RelayPart, RelaySegment, SegmentWindow } from '../relay/segment-window.js';
import { MPEG_CLOCK_HZ, timestampDelta } from '../relay/mpegts.js';

/** Ce qu'une vue de session lit d'une sortie média (directe ou transcodée). */
export interface ViewSource {
  readonly window: Pick<SegmentWindow, 'segments' | 'pendingParts'>;
  readonly nextSeq: number;
  segment(seq: number): Buffer | undefined;
  part(seq: number, index: number): Buffer | undefined;
  waitFor(seq: number, part: number | undefined, timeoutMs: number): Promise<void>;
}

export interface ViewPlaylistSettings {
  targetDurationS: number;
  holdBackS: number;
  partTargetS: number;
  partHoldBackS: number;
}

/** Une image près (40 ms à 25 i/s) : deux sorties d'un même flux se recalent à cette tolérance. */
const ALIGN_TOLERANCE_TICKS = 0.04 * MPEG_CLOCK_HZ;
const ALIGN_TOLERANCE_MS = 40;
/**
 * Une sortie transcodée a toujours un peu de retard sur la sortie directe (le temps de
 * FFmpeg) : sans attente, la vue reprendrait sans fin le segment direct suivant avant que son
 * équivalent existe. Pendant un changement, on cesse donc d'ajouter l'ancienne sortie, au plus
 * ce délai (le lecteur puise dans son avance), le temps que la nouvelle la rattrape.
 */
const SWITCH_HOLD_MS = 4000;

interface Entry {
  seq: number;
  source: ViewSource;
  sourceSeq: number;
  segment: RelaySegment;
  discontinuity: boolean;
}

/**
 * La playlist d'un spectateur : sa propre numérotation, continue, quelle que soit la sortie
 * qu'il lit. Passer d'une sortie à l'autre (qualité réduite, conversion de format) se fait au
 * premier segment à image clé qui suit exactement ce qui a déjà été joué, avec une jonction
 * marquée (EXT-X-DISCONTINUITY) : le lecteur continue sans se réinitialiser, comme lors
 * d'une bascule de source.
 */
export class SessionView {
  private entries: Entry[] = [];
  private nextSessionSeq = 0;
  private evictedDiscontinuities = 0;
  private current: ViewSource;
  private pending: ViewSource | null = null;
  /** Début de l'attente de la sortie à rejoindre (voir SWITCH_HOLD_MS). */
  private holdSince = 0;
  /** Dernier segment de la sortie en cours déjà repris dans la vue. */
  private lastSourceSeq = -1;
  private forceDiscontinuity = false;

  constructor(
    source: ViewSource,
    private readonly windowS: number,
    private readonly settings: ViewPlaylistSettings,
  ) {
    this.current = source;
    this.sync();
  }

  /** Sortie lue en ce moment (ou celle que l'on rejoindra au prochain point de rendez-vous). */
  get source(): ViewSource {
    return this.pending ?? this.current;
  }

  /** Sorties encore lues : en cours, à rejoindre, ou présentes dans la fenêtre de la playlist. */
  sourcesInUse(): Set<ViewSource> {
    this.sync();
    const used = new Set<ViewSource>([this.current]);
    if (this.pending !== null) used.add(this.pending);
    for (const e of this.entries) used.add(e.source);
    return used;
  }

  /** Change de sortie au prochain segment à image clé qui suit ce qui a déjà été joué. */
  switchTo(source: ViewSource): void {
    this.pending = source === this.current ? null : source;
    this.holdSince = Date.now();
    this.sync();
  }

  /** Le segment de `candidate` commence-t-il après la fin du dernier segment joué ? */
  private follows(candidate: RelaySegment, last: RelaySegment | undefined): boolean {
    if (last === undefined) return true;
    if (candidate.sourceId === last.sourceId) {
      const lastEnd = last.startTs + Math.round(last.durationS * MPEG_CLOCK_HZ);
      return timestampDelta(lastEnd, candidate.startTs) >= -ALIGN_TOLERANCE_TICKS;
    }
    // Sources différentes : pas d'horodatage commun, l'horloge murale départage.
    return candidate.programDateTimeMs >= last.programDateTimeMs + last.durationS * 1000 - ALIGN_TOLERANCE_MS;
  }

  private sync(): void {
    const last = this.entries.at(-1)?.segment;
    if (this.pending !== null) {
      const target = this.pending;
      const join = target.window.segments.find((s) => s.independent && this.follows(s, last));
      if (join !== undefined) {
        this.current = target;
        this.pending = null;
        this.lastSourceSeq = join.seq - 1;
        this.forceDiscontinuity = this.entries.length > 0;
      } else if (Date.now() - this.holdSince < SWITCH_HOLD_MS) {
        // La nouvelle sortie n'est pas encore au rendez-vous : on l'attend, sans avancer l'ancienne.
        return;
      } else {
        // Trop long : l'ancienne sortie avance d'un cran, puis on attend de nouveau.
        this.holdSince = Date.now();
      }
    }
    const segments = this.current.window.segments;
    // Sortie qui a évincé des segments que la vue n'a pas repris (session longtemps muette) : saut.
    const first = segments[0];
    if (first !== undefined && first.seq > this.lastSourceSeq + 1 && this.entries.length > 0) {
      this.forceDiscontinuity = true;
    }
    for (const s of segments) {
      if (s.seq <= this.lastSourceSeq) continue;
      this.entries.push({
        seq: this.nextSessionSeq++,
        source: this.current,
        sourceSeq: s.seq,
        segment: s,
        discontinuity: (s.discontinuity || this.forceDiscontinuity) && this.entries.length > 0,
      });
      this.forceDiscontinuity = false;
      this.lastSourceSeq = s.seq;
    }
    this.evict();
  }

  private evict(): void {
    let total = this.entries.reduce((t, e) => t + e.segment.durationS, 0);
    for (;;) {
      const first = this.entries[0];
      if (first === undefined || this.entries.length === 1 || total - first.segment.durationS < this.windowS)
        return;
      this.entries.shift();
      total -= first.segment.durationS;
      if (first.discontinuity) this.evictedDiscontinuities++;
    }
  }

  get nextSeq(): number {
    this.sync();
    return this.nextSessionSeq;
  }

  playlist(uri: SegmentUri, lowLatency: boolean): string {
    this.sync();
    const segments: RelaySegment[] = this.entries.map((e) => ({
      ...e.segment,
      seq: e.seq,
      discontinuity: e.discontinuity,
      // Parties : seulement celles de la sortie en cours, la seule qui grandit encore.
      parts: lowLatency && e.source === this.current ? e.segment.parts : [],
    }));
    const pendingParts: readonly RelayPart[] = this.pending === null ? this.current.window.pendingParts : [];
    return renderPlaylist(
      {
        mediaSequence: this.entries[0]?.seq ?? this.nextSessionSeq,
        discontinuitySequence: this.evictedDiscontinuities,
        segments,
        targetDurationS: this.settings.targetDurationS,
        blockingReload: { holdBackS: this.settings.holdBackS },
        ...(lowLatency && this.settings.partTargetS > 0
          ? {
              lowLatency: {
                partTargetS: this.settings.partTargetS,
                partHoldBackS: this.settings.partHoldBackS,
                pendingParts,
                nextSeq: this.nextSessionSeq,
              },
            }
          : {}),
      },
      uri,
    );
  }

  private entry(seq: number): Entry | undefined {
    const first = this.entries[0];
    return first === undefined ? undefined : this.entries[seq - first.seq];
  }

  segment(seq: number): Buffer | undefined {
    const e = this.entry(seq);
    return e === undefined ? undefined : e.source.segment(e.sourceSeq);
  }

  part(seq: number, index: number): Buffer | undefined {
    this.sync();
    if (seq === this.nextSessionSeq) return this.current.part(this.lastSourceSeq + 1, index);
    const e = this.entry(seq);
    return e === undefined ? undefined : e.source.part(e.sourceSeq, index);
  }

  /** Rechargement bloquant : le segment (ou la partie) `seq` de la vue paraît dans la sortie en cours. */
  async waitFor(seq: number, part: number | undefined, timeoutMs: number): Promise<void> {
    this.sync();
    if (seq < this.nextSessionSeq) return;
    if (seq === this.nextSessionSeq) {
      // Changement en cours : c'est la nouvelle sortie qui donnera le prochain segment.
      const pending = this.pending;
      if (pending !== null)
        await pending.waitFor(pending.nextSeq, undefined, Math.min(timeoutMs, SWITCH_HOLD_MS));
      else await this.current.waitFor(this.lastSourceSeq + 1, part, timeoutMs);
      this.sync();
    }
  }
}

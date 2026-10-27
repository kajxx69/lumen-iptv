import type { SegmentDraft } from './segmenter.js';

export interface RelaySegment {
  /** Numéro attribué par le relais : continu, quelle que soit la source amont. */
  seq: number;
  durationS: number;
  data: Buffer;
  discontinuity: boolean;
  independent: boolean;
  /** Horodatage mural du début du segment (EXT-X-PROGRAM-DATE-TIME). */
  programDateTimeMs: number;
  sourceId: string;
}

const MS_PER_S = 1000;

/**
 * Tampon glissant d'un relais : les derniers segments, au moins `capacityS` secondes.
 * Tient les deux compteurs que la RFC 8216 impose de faire glisser ensemble :
 * EXT-X-MEDIA-SEQUENCE et EXT-X-DISCONTINUITY-SEQUENCE.
 */
export class SegmentWindow {
  private readonly list: RelaySegment[] = [];
  private nextSeq = 0;
  private evictedDiscontinuities = 0;
  private totalS = 0;

  constructor(
    private readonly capacityS: number,
    private readonly onEvict: (segment: RelaySegment) => void = () => undefined,
  ) {}

  append(draft: SegmentDraft & { sourceId: string }, nowMs: number): RelaySegment {
    const prev = this.list.at(-1);
    // Une discontinuité sur le tout premier segment ne joint rien : inutile pour le lecteur.
    const discontinuity = draft.discontinuity && this.nextSeq > 0;
    const prevEnd = prev === undefined ? null : prev.programDateTimeMs + prev.durationS * MS_PER_S;
    const durationMs = draft.durationS * MS_PER_S;
    // Même source : horodatages contigus. À la jonction : recalage sur l'horloge murale
    // (le segment vient de se terminer), sans jamais revenir en arrière.
    const programDateTimeMs =
      prevEnd !== null && !discontinuity ? prevEnd : Math.max(nowMs - durationMs, prevEnd ?? -Infinity);
    const segment: RelaySegment = {
      seq: this.nextSeq++,
      durationS: draft.durationS,
      data: draft.data,
      discontinuity,
      independent: draft.independent,
      programDateTimeMs: Math.round(programDateTimeMs),
      sourceId: draft.sourceId,
    };
    this.list.push(segment);
    this.totalS += segment.durationS;
    this.evict();
    return segment;
  }

  private evict(): void {
    for (;;) {
      const first = this.list[0];
      if (first === undefined || this.list.length === 1 || this.totalS - first.durationS < this.capacityS)
        return;
      this.list.shift();
      this.totalS -= first.durationS;
      if (first.discontinuity) this.evictedDiscontinuities++;
      this.onEvict(first);
    }
  }

  get(seq: number): RelaySegment | undefined {
    const first = this.list[0];
    if (first === undefined) return undefined;
    return this.list[seq - first.seq];
  }

  get segments(): readonly RelaySegment[] {
    return this.list;
  }

  get mediaSequence(): number {
    return this.list[0]?.seq ?? this.nextSeq;
  }

  get discontinuitySequence(): number {
    return this.evictedDiscontinuities;
  }

  get bufferedS(): number {
    return Math.round(this.totalS * MS_PER_S) / MS_PER_S;
  }

  get bytes(): number {
    return this.list.reduce((n, s) => n + s.data.length, 0);
  }
}

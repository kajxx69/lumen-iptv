import type { PartDraft, SegmentDraft } from './segmenter.js';

/** Partie de segment (LL-HLS). */
export type RelayPart = PartDraft;

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
  /** Ses parties, gardées tant qu'elles sont proches du direct ; vide ensuite. */
  parts: RelayPart[];
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
  private pending: RelayPart[] = [];

  /**
   * @param partsKeptS parties gardées pour les segments commencés depuis moins de ce délai
   * avant le direct : la RFC 8216bis les exige sur trois durées cibles, pas au-delà.
   */
  constructor(
    private readonly capacityS: number,
    private readonly onEvict: (segment: RelaySegment) => void = () => undefined,
    private readonly partsKeptS = 0,
  ) {}

  /** Une partie du segment en cours vient de paraître. */
  appendPart(part: RelayPart): void {
    this.pending.push(part);
  }

  /** Parties déjà publiées du segment en cours (numéro `nextSeq`). */
  get pendingParts(): readonly RelayPart[] {
    return this.pending;
  }

  part(seq: number, index: number): RelayPart | undefined {
    if (seq === this.nextSeq) return this.pending[index];
    return this.get(seq)?.parts[index];
  }

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
      parts: draft.parts,
    };
    this.pending = [];
    this.list.push(segment);
    this.totalS += segment.durationS;
    this.evict();
    this.releaseOldParts();
    return segment;
  }

  /** Les parties ne servent qu'aux lecteurs proches du direct : celles des segments anciens partent. */
  private releaseOldParts(): void {
    let fromEnd = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (s === undefined) continue;
      fromEnd += s.durationS;
      if (fromEnd > this.partsKeptS && s.parts.length > 0) s.parts = [];
    }
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

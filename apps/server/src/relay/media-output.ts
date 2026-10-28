import { renderPlaylist, type SegmentUri } from './playlist.js';
import type { SegmentCache } from './segment-cache.js';
import { type RelaySegment, SegmentWindow } from './segment-window.js';
import { type SegmentDraft, type SegmenterOptions, TsSegmenter } from './segmenter.js';

export interface MediaOutputOptions {
  bufferS: number;
  targetDurationS: number;
  /** Retard visé en lecture confort (HOLD-BACK). */
  holdBackS: number;
  /** Retard visé en « direct au plus près » (PART-HOLD-BACK, LL-HLS). */
  partHoldBackS: number;
  segmenter: SegmenterOptions;
}

/**
 * Les parties ne sont gardées que près du direct : la RFC 8216bis les exige sur les trois
 * dernières durées cibles de la playlist, pas au-delà.
 */
const PARTS_KEPT_TARGET_DURATIONS = 3;

interface Waiter {
  seq: number;
  part: number | undefined;
  done: () => void;
}

/**
 * Une sortie média d'un relais : flux MPEG-TS découpé en segments (et en parties pour le
 * LL-HLS), fenêtre glissante, playlist, rechargements bloquants. La sortie directe du
 * relais en est une ; chaque sortie transcodée en est une autre.
 */
export class MediaOutput {
  readonly segmenter: TsSegmenter;
  readonly window: SegmentWindow;
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly cacheKey: string,
    private readonly options: MediaOutputOptions,
    private readonly cache: SegmentCache,
    sourceId: () => string,
    onSegment: (segment: RelaySegment, draft: SegmentDraft) => void = () => undefined,
  ) {
    this.window = new SegmentWindow(
      options.bufferS,
      (s) => {
        cache.put(cacheKey, s.seq, s.data);
      },
      PARTS_KEPT_TARGET_DURATIONS * options.targetDurationS,
    );
    this.segmenter = new TsSegmenter(
      options.segmenter,
      (draft) => {
        const segment = this.window.append({ ...draft, sourceId: sourceId() }, Date.now());
        onSegment(segment, draft);
        this.wake();
      },
      (part) => {
        this.window.appendPart(part);
        this.wake();
      },
    );
  }

  push(bytes: Uint8Array): void {
    this.segmenter.push(bytes);
  }

  breakStream(): void {
    this.segmenter.breakStream();
  }

  playlist(uri: SegmentUri, lowLatency: boolean): string {
    return renderPlaylist(
      {
        mediaSequence: this.window.mediaSequence,
        discontinuitySequence: this.window.discontinuitySequence,
        segments: this.window.segments,
        targetDurationS: this.options.targetDurationS,
        blockingReload: { holdBackS: this.options.holdBackS },
        ...(lowLatency && this.options.segmenter.partTargetS > 0
          ? {
              lowLatency: {
                partTargetS: this.options.segmenter.partTargetS,
                partHoldBackS: this.options.partHoldBackS,
                pendingParts: this.window.pendingParts,
                nextSeq: this.nextSeq,
              },
            }
          : {}),
      },
      uri,
    );
  }

  /** Prochain numéro de segment (celui en cours de publication). */
  get nextSeq(): number {
    return (this.window.segments.at(-1)?.seq ?? this.window.mediaSequence - 1) + 1;
  }

  private available(seq: number, part: number | undefined): boolean {
    if (seq < this.nextSeq) return true;
    return seq === this.nextSeq && part !== undefined && part < this.window.pendingParts.length;
  }

  /**
   * Rechargement bloquant : résolu dès que le segment `seq` (ou sa partie `part`) paraît, ou
   * à l'échéance — la playlist actuelle part alors telle quelle, le lecteur redemandera.
   */
  waitFor(seq: number, part: number | undefined, timeoutMs: number): Promise<void> {
    if (this.available(seq, part)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter: Waiter = { seq, part, done: () => undefined };
      const timer = setTimeout(() => {
        waiter.done();
      }, timeoutMs);
      waiter.done = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      this.waiters.add(waiter);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) if (this.available(w.seq, w.part)) w.done();
  }

  /**
   * Le flux récent, à partir du dernier segment qui commence par une image clé, segment en
   * cours compris : de quoi amorcer un transcodage sans attendre l'image clé suivante.
   */
  recentStream(): Buffer[] {
    const segments = this.window.segments;
    let from = segments.length - 1;
    while (from > 0 && segments[from]?.independent !== true) from--;
    const data = segments.slice(Math.max(0, from)).map((s) => s.data);
    const pending = this.segmenter.pendingData();
    return pending === null ? data : [...data, pending];
  }

  segment(seq: number): Buffer | undefined {
    return this.window.get(seq)?.data ?? this.cache.get(this.cacheKey, seq);
  }

  part(seq: number, index: number): Buffer | undefined {
    return this.window.part(seq, index)?.data;
  }

  get bytes(): number {
    return this.window.bytes;
  }

  close(): void {
    this.cache.forget(this.cacheKey);
    for (const w of [...this.waiters]) w.done();
  }
}

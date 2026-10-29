import { VOD_TIMELINE_EPOCH_MS } from '@lumen/protocol';
import { MPEG_CLOCK_HZ, timestampDelta } from '../relay/mpegts.js';
import type { SegmentDraft } from '../relay/segmenter.js';

const MS_PER_S = 1000;

export interface VodSegment {
  seq: number;
  durationS: number;
  /** Position de son début dans le film (s). */
  mediaStartS: number;
  /** null : libéré (loin derrière le lecteur). */
  data: Buffer | null;
  discontinuity: boolean;
}

export interface VodSegmentsOptions {
  /** Avance produite au plus devant le dernier segment demandé. */
  aheadS: number;
  /** Données gardées derrière le dernier segment demandé. */
  behindS: number;
  /** EXT-X-TARGETDURATION minimale. */
  targetDurationS: number;
}

export type VodSegmentUri = (seq: number) => string;

/**
 * Segments d'une lecture de film. Chacun connaît sa position dans le film, tirée de son
 * horodatage (FFmpeg garde ceux du fichier) : la playlist la porte en EXT-X-PROGRAM-DATE-TIME,
 * le lecteur affiche ainsi la vraie position, quel que soit le point de départ.
 *
 * Playlist de type EVENT : elle ne fait que grandir, le lecteur ne « sort » jamais de la
 * fenêtre. La mémoire, elle, est bornée : la production s'arrête à `aheadS` devant le
 * lecteur, et les segments loin derrière lui sont libérés (y revenir relance la lecture
 * au bon endroit).
 */
export class VodSegments {
  private readonly list: VodSegment[] = [];
  private lastRequested = -1;
  private ended = false;

  constructor(
    private readonly options: VodSegmentsOptions,
    /** Horodatage du début du fichier (90 kHz) : position 0 du film. */
    private readonly originTicks: number,
    /**
     * Position demandée (s). Un flux qui ne sait pas sauter (archive en flux continu, serveur
     * sans Range) est lu depuis son début : tout segment fini avant cette position est écarté.
     * Un fichier qui sait sauter commence déjà à l'image clé qui la précède : rien n'est écarté.
     */
    private readonly fromS = 0,
  ) {}

  get count(): number {
    return this.list.length;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Segment du découpeur ; null s'il finit avant la position demandée (écarté). */
  add(draft: SegmentDraft): VodSegment | null {
    // Les images B d'avant le début donnent un léger négatif : la position commence à 0.
    const mediaStartS = Math.max(0, timestampDelta(this.originTicks, draft.startTs) / MPEG_CLOCK_HZ);
    if (mediaStartS + draft.durationS <= this.fromS) return null;
    const segment: VodSegment = {
      seq: this.list.length,
      durationS: draft.durationS,
      mediaStartS,
      data: draft.data,
      discontinuity: draft.discontinuity && this.list.length > 0,
    };
    this.list.push(segment);
    return segment;
  }

  /** Fin du fichier atteinte : la playlist se clôt (EXT-X-ENDLIST). */
  end(): void {
    this.ended = true;
  }

  /** Secondes produites au-delà du dernier segment demandé par le lecteur. */
  aheadS(): number {
    let total = 0;
    for (let i = this.list.length - 1; i > this.lastRequested; i--) total += this.list[i]?.durationS ?? 0;
    return total;
  }

  /** Assez d'avance : FFmpeg peut s'arrêter jusqu'à la prochaine demande du lecteur. */
  get full(): boolean {
    return this.aheadS() >= this.options.aheadS;
  }

  /** Segment demandé par le lecteur ; null s'il n'existe pas ou a été libéré. */
  request(seq: number): VodSegment | null {
    const segment = this.list[seq];
    if (segment === undefined) return null;
    if (seq > this.lastRequested) {
      this.lastRequested = seq;
      this.release();
    }
    return segment.data === null ? null : segment;
  }

  private release(): void {
    let kept = 0;
    for (let i = this.lastRequested - 1; i >= 0; i--) {
      const s = this.list[i];
      if (s === undefined) continue;
      if (kept >= this.options.behindS) {
        if (s.data === null) break;
        s.data = null;
        continue;
      }
      kept += s.durationS;
    }
  }

  playlist(uri: VodSegmentUri): string {
    const longest = this.list.reduce((m, s) => Math.max(m, Math.round(s.durationS)), 0);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.max(Math.ceil(this.options.targetDurationS), longest)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
    ];
    for (const s of this.list) {
      if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(VOD_TIMELINE_EPOCH_MS + Math.round(s.mediaStartS * MS_PER_S)).toISOString()}`,
      );
      lines.push(`#EXTINF:${s.durationS.toFixed(3)},`);
      lines.push(uri(s.seq));
    }
    if (this.ended) lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
  }
}

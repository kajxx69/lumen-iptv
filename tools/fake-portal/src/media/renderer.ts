import type { ChaosController } from '../chaos/controller.js';
import { hashSeed, mulberry32 } from '../random.js';
import { type LoopAsset, type MediaAssets, loopTicks } from './assets.js';
import {
  MPEG_CLOCK_HZ,
  MPEG_TICKS_PER_MS,
  TS_PACKET_SIZE,
  pcrAt,
  pesTimestampsAt,
  readHeader,
  readPcrBase,
  readTimestamp,
  writePcrBase,
  writeTimestamp,
} from './mpegts.js';

/**
 * Valeur PTS qui correspond à l'origine de la timeline. La marge garde positifs l'audio
 * amorcé par l'encodeur AAC et le PCR, légèrement en avance sur les PTS.
 */
export const PTS_ORIGIN_TICKS = 10 * MPEG_CLOCK_HZ;

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * Horloge commune à toutes les chaînes : le segment k couvre
 * [epoch + k·D, epoch + (k+1)·D). Les PTS en sortie sont une fonction affine de ce temps,
 * ce qui permet à un test de relier un PTS à l'instant mural où il a été produit.
 */
export class LiveTimeline {
  readonly segmentMs: number;

  constructor(
    readonly epochMs: number,
    segmentDurationS: number,
  ) {
    this.segmentMs = segmentDurationS * 1000;
  }

  segmentAt(ms: number): number {
    return Math.floor((ms - this.epochMs) / this.segmentMs);
  }

  segmentStartMs(k: number): number {
    return this.epochMs + k * this.segmentMs;
  }

  /** PTS (non replié sur 33 bits) correspondant à un instant mural. */
  ptsAt(ms: number): number {
    return PTS_ORIGIN_TICKS + (ms - this.epochMs) * MPEG_TICKS_PER_MS;
  }

  msAtPts(unwrappedPts: number): number {
    return this.epochMs + (unwrappedPts - PTS_ORIGIN_TICKS) / MPEG_TICKS_PER_MS;
  }
}

export interface PacketRange {
  from: number;
  to: number;
}

export class SegmentRenderer {
  constructor(
    private readonly assets: MediaAssets,
    readonly timeline: LiveTimeline,
    private readonly chaos: ChaosController,
    private readonly corruptPacketRatio: number,
  ) {}

  /** Le choix mire / noir se fait par segment entier : un GOP ne peut pas être coupé. */
  assetFor(channelId: string, k: number): LoopAsset {
    return this.chaos.isBlackAt(channelId, this.timeline.segmentStartMs(k))
      ? this.assets.black
      : this.assets.mire;
  }

  packetCount(asset: LoopAsset, k: number): number {
    return asset.packetCounts[mod(k, asset.segments.length)] ?? 0;
  }

  /**
   * Produit les paquets [from, to) du segment k de la chaîne, avec horodatages continus
   * et pannes appliquées. Fonction pure de l'état de chaos : deux appels identiques
   * renvoient les mêmes octets.
   */
  render(channelId: string, k: number, asset = this.assetFor(channelId, k), range?: PacketRange): Buffer {
    const n = asset.segments.length;
    const source = asset.segments[mod(k, n)];
    if (source === undefined) throw new RangeError(`segment ${k} absent`);
    const from = range?.from ?? 0;
    const to = range?.to ?? source.length / TS_PACKET_SIZE;
    const out = Buffer.from(source.subarray(from * TS_PACKET_SIZE, to * TS_PACKET_SIZE));

    const loopIndex = Math.floor(k / n);
    const offset = loopIndex * loopTicks(asset) + PTS_ORIGIN_TICKS - asset.baseVideoPts;
    const corrupted = this.chaos.isSegmentCorrupted(channelId, k);

    for (let off = 0, index = from; off < out.length; off += TS_PACKET_SIZE, index++) {
      const header = readHeader(out, off);
      const pcr = pcrAt(out, off, header);
      // Le PCR continue d'avancer pendant un gel : l'horloge du multiplex reste vivante,
      // seul le contenu est figé. C'est ce qui rend le gel invisible au niveau réseau.
      if (pcr !== null) writePcrBase(out, pcr, readPcrBase(out, pcr) + offset);

      const pes = pesTimestampsAt(out, off, header);
      if (pes?.ptsAt != null) {
        const pts = readTimestamp(out, pes.ptsAt) + offset;
        const frozen = this.chaos.freezeAt(channelId, this.timeline.msAtPts(pts));
        const frozenPts = frozen === null ? null : this.timeline.ptsAt(frozen.startMs);
        writeTimestamp(out, pes.ptsAt, frozenPts ?? pts);
        if (pes.dtsAt !== null) {
          writeTimestamp(out, pes.dtsAt, frozenPts ?? readTimestamp(out, pes.dtsAt) + offset);
        }
      }

      if (corrupted) this.corruptPacket(out, off, header.payloadOffset, channelId, k, index);
    }
    return out;
  }

  private corruptPacket(
    buf: Buffer,
    off: number,
    payloadOffset: number,
    channelId: string,
    k: number,
    index: number,
  ): void {
    const rng = mulberry32(hashSeed(this.chaos.corruptionSeed, channelId, k, index));
    if (rng() >= this.corruptPacketRatio) return;
    // En-tête TS préservé : le flux reste démultiplexable, seul le contenu est abîmé,
    // comme lors d'une perte de paquets sur le lien amont.
    for (let i = Math.max(payloadOffset, off + 4); i < off + TS_PACKET_SIZE; i++) {
      buf[i] = Math.floor(rng() * 256);
    }
  }
}

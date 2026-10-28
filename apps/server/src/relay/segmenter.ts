import {
  KeyframeScanner,
  MPEG_CLOCK_HZ,
  NULL_PID,
  PAT_PID,
  type ProgramStreams,
  TS_PACKET_SIZE,
  TS_SYNC_BYTE,
  packetPid,
  parsePat,
  parsePmt,
  payloadOffset,
  payloadUnitStart,
  randomAccess,
  readPesHeader,
  setContinuityCounter,
  timestampDelta,
} from './mpegts.js';

export interface SegmenterOptions {
  /** Un segment est coupé à la première image clé atteignant cette durée. */
  targetDurationS: number;
  /** Durée visée du premier segment d'une connexion : plus court, il démarre la lecture plus tôt. */
  firstTargetDurationS: number;
  /**
   * Phase de démarrage d'une nouvelle source (zapping, bascule, reconnexion) : pendant ces
   * secondes de flux, les segments sont coupés à `firstTargetDurationS` sans attendre
   * l'image clé suivante. Le lecteur, qui n'a presque pas d'avance à ce moment-là, reçoit
   * la nouvelle source au fil de l'eau plutôt qu'au bout d'un GOP entier. 0 : désactivé.
   */
  fastStartS: number;
  /** Sans image clé, coupe forcée à cette durée (doit rester sous EXT-X-TARGETDURATION). */
  forceCutDurationS: number;
  /** Un écart d'horodatage plus grand est une rupture du flux, pas une image suivante. */
  timestampJumpS: number;
  /** En deçà, un segment interrompu par une rupture est jeté plutôt que publié. */
  minFlushDurationS: number;
  /**
   * Parties de segment (LL-HLS) : durée maximale d'une partie, annoncée en PART-TARGET. Les
   * lecteurs « direct au plus près » reçoivent le flux par parties, sans attendre la fin du
   * segment. 0 : pas de parties.
   */
  partTargetS: number;
}

/** Une partie de segment : PAT et PMT en tête, décodable à la suite de la précédente. */
export interface PartDraft {
  data: Buffer;
  durationS: number;
  /** Commence par une image clé : un lecteur peut y démarrer. */
  independent: boolean;
  /** Appartient au premier segment d'une nouvelle source : la jonction précède la partie. */
  discontinuity: boolean;
}

export interface SegmentDraft {
  data: Buffer;
  durationS: number;
  /** Commence par une image clé : décodable sans le segment précédent. */
  independent: boolean;
  /** Premier segment après une rupture : nouvelle connexion ou saut d'horodatage. */
  discontinuity: boolean;
  /** Ses parties (LL-HLS), déjà publiées une à une ; vide sans parties. */
  parts: PartDraft[];
}

export interface SegmenterStats {
  forcedCuts: number;
  timestampJumps: number;
  /** Images dont l'horodatage avance : un flux figé reçoit des octets sans faire monter ce compteur. */
  timestampAdvances: number;
  resyncs: number;
}

interface PendingKeyframe {
  /** Index, dans le segment en cours, du paquet qui ouvre l'image. */
  index: number;
  ts: number;
  scanner: KeyframeScanner;
}

/**
 * Découpe un flux MPEG-TS continu en segments HLS autonomes : coupe aux images clés,
 * PAT et PMT en tête de chaque segment, durées tirées des horodatages (jamais de
 * l'horloge murale). Purement synchrone : les octets entrent, les segments sortent.
 */
export class TsSegmenter {
  readonly stats: SegmenterStats = { forcedCuts: 0, timestampJumps: 0, resyncs: 0, timestampAdvances: 0 };
  private carry: Uint8Array = new Uint8Array(0);

  // Tables du programme en cours (réinitialisées à chaque rupture de connexion).
  private pat: Uint8Array | null = null;
  private pmt: Uint8Array | null = null;
  private pmtPid: number | null = null;
  private streams: ProgramStreams | null = null;
  /** Un amont qui pose random_access_indicator est cru sur parole : pas d'analyse NAL. */
  private trustsRai = false;
  private patCc = 0;
  private pmtCc = 0;

  // Segment en cours.
  private packets: Uint8Array[] = [];
  private startTs: number | null = null;
  private startIndependent = true;
  private lastTs: number | null = null;
  private frameTicks = 0;
  private pending: PendingKeyframe | null = null;
  private segmentsSinceBreak = 0;
  private nextDiscontinuity = false;
  /** Horodatage de la première image clé de la source en cours (début du démarrage rapide). */
  private sourceStartTs: number | null = null;

  // Partie en cours (LL-HLS) : paquets [partStart, …) du segment en cours.
  private partStart = 0;
  private partStartTs: number | null = null;
  private partIndependent = true;
  private parts: PartDraft[] = [];
  /** Compteurs propres aux tables des parties : continus pour qui lit les parties. */
  private partPatCc = 0;
  private partPmtCc = 0;

  constructor(
    private readonly options: SegmenterOptions,
    private readonly emit: (segment: SegmentDraft) => void,
    private readonly emitPart: (part: PartDraft) => void = () => undefined,
  ) {}

  /** Flux du programme en cours (codecs) : décide d'un éventuel transcodage. */
  get programStreams(): ProgramStreams | null {
    return this.streams;
  }

  /** Le segment en cours, pas encore publié (PAT et PMT en tête) ; null s'il n'y en a pas. */
  pendingData(): Buffer | null {
    if (this.startTs === null || this.pat === null || this.pmt === null || this.packets.length === 0)
      return null;
    return withTables(this.pat, this.pmt, this.packets);
  }

  push(chunk: Uint8Array): void {
    const buf = this.carry.length === 0 ? chunk : concat(this.carry, chunk);
    let off = 0;
    while (off + TS_PACKET_SIZE <= buf.length) {
      // Un paquet n'est accepté que si le suivant commence aussi par l'octet de synchronisation :
      // un 0x47 isolé au milieu de données parasites ne fait pas dérailler le découpage.
      const next = off + TS_PACKET_SIZE;
      if (buf[off] === TS_SYNC_BYTE && (next >= buf.length || buf[next] === TS_SYNC_BYTE)) {
        if (next === buf.length) break; // Dernier paquet : attendre l'octet suivant pour le valider.
        this.handle(buf.subarray(off, next));
        off = next;
        continue;
      }
      this.stats.resyncs++;
      off = this.findSync(buf, off + 1);
    }
    this.carry = buf.subarray(off);
  }

  /**
   * Fin de la connexion amont (ou changement de source) : le segment en cours est publié
   * s'il est assez long, et le suivant portera une discontinuité.
   */
  breakStream(): void {
    if (this.carry.length >= TS_PACKET_SIZE && this.carry[0] === TS_SYNC_BYTE) {
      this.handle(this.carry.subarray(0, TS_PACKET_SIZE));
    }
    this.carry = new Uint8Array(0);
    this.flushPartial();
    this.nextDiscontinuity = true;
    this.pat = null;
    this.pmt = null;
    this.pmtPid = null;
    this.streams = null;
    this.trustsRai = false;
    this.lastTs = null;
    this.frameTicks = 0;
    this.segmentsSinceBreak = 0;
    this.sourceStartTs = null;
  }

  private inFastStart(ts: number): boolean {
    return (
      this.sourceStartTs !== null &&
      timestampDelta(this.sourceStartTs, ts) < this.options.fastStartS * MPEG_CLOCK_HZ
    );
  }

  private findSync(buf: Uint8Array, from: number): number {
    for (let i = from; i + TS_PACKET_SIZE <= buf.length; i++) {
      if (
        buf[i] === TS_SYNC_BYTE &&
        (i + TS_PACKET_SIZE >= buf.length || buf[i + TS_PACKET_SIZE] === TS_SYNC_BYTE)
      )
        return i;
    }
    // Garder la fin : un paquet peut commencer dans les derniers octets.
    return Math.max(from, buf.length - TS_PACKET_SIZE + 1);
  }

  private handle(pkt: Uint8Array): void {
    const pid = packetPid(pkt, 0);
    if (pid === NULL_PID) return; // Bourrage : des octets payés pour rien sur mobile.
    if (pid === PAT_PID) {
      const pmtPid = parsePat(pkt, 0);
      if (pmtPid !== null) {
        if (pmtPid !== this.pmtPid) {
          this.pmt = null;
          this.streams = null;
        }
        this.pmtPid = pmtPid;
        this.pat = Uint8Array.from(pkt);
      }
      return;
    }
    if (pid === this.pmtPid) {
      const streams = parsePmt(pkt, 0);
      if (streams !== null && (streams.videoPid !== null || streams.audioPids.length > 0)) {
        this.streams = streams;
        this.pmt = Uint8Array.from(pkt);
      }
      return;
    }
    const streams = this.streams;
    if (streams === null) return; // Indécodable sans PMT.

    const timingPid = streams.videoPid ?? streams.audioPids[0];
    if (pid === timingPid) {
      if (payloadUnitStart(pkt, 0)) this.onFrameStart(pkt, streams);
      else this.continueScan(pkt);
    }
    this.packets.push(pkt);
  }

  private onFrameStart(pkt: Uint8Array, streams: ProgramStreams): void {
    // Une image précédente encore indécise est différentielle : sa clé n'est jamais venue.
    this.pending = null;
    const p = payloadOffset(pkt, 0);
    const pes = p < 0 ? null : readPesHeader(pkt, p, TS_PACKET_SIZE);
    const ts = pes?.decodeTs ?? null;
    if (ts === null || pes === null) return;

    if (this.lastTs !== null) {
      const delta = timestampDelta(this.lastTs, ts);
      const jump = this.options.timestampJumpS * MPEG_CLOCK_HZ;
      if (delta > jump || delta < -jump) {
        this.stats.timestampJumps++;
        this.flushPartial();
        this.nextDiscontinuity = true;
        this.segmentsSinceBreak = 0;
        this.sourceStartTs = null;
      } else if (delta > 0) {
        this.frameTicks = delta;
      }
    }
    if (this.lastTs === null || timestampDelta(this.lastTs, ts) !== 0) this.stats.timestampAdvances++;
    this.lastTs = ts;
    // Avant la première image clé : ce qui a été reçu est indécodable.
    if (this.startTs === null) this.packets = [];
    const index = this.packets.length;
    this.maybeEndPart(index, ts);

    // Audio seul (radio) : chaque trame est un point d'entrée.
    const isVideo = packetPid(pkt, 0) === streams.videoPid;
    if (!isVideo || randomAccess(pkt, 0)) {
      if (isVideo) this.trustsRai = true;
      this.onKeyframe(index, ts);
      return;
    }
    if (
      this.startTs !== null &&
      this.inFastStart(ts) &&
      timestampDelta(this.startTs, ts) >= this.options.firstTargetDurationS * MPEG_CLOCK_HZ
    ) {
      this.cut(index, ts, false);
      return;
    }
    if (
      this.startTs !== null &&
      timestampDelta(this.startTs, ts) >= this.options.forceCutDurationS * MPEG_CLOCK_HZ
    ) {
      this.stats.forcedCuts++;
      this.cut(index, ts, false);
      return;
    }
    if (this.trustsRai || streams.videoCodec === null) return;
    const scanner = new KeyframeScanner(streams.videoCodec);
    const verdict = scanner.feed(pkt.subarray(pes.dataOffset));
    if (verdict === true) this.onKeyframe(index, ts);
    else if (verdict === null) this.pending = { index, ts, scanner };
  }

  private continueScan(pkt: Uint8Array): void {
    const pending = this.pending;
    if (pending === null) return;
    const p = payloadOffset(pkt, 0);
    if (p < 0) return;
    const verdict = pending.scanner.feed(pkt.subarray(p));
    if (verdict === null) return;
    this.pending = null;
    if (verdict) this.onKeyframe(pending.index, pending.ts);
  }

  private onKeyframe(index: number, ts: number): void {
    if (this.startTs === null) {
      this.packets = this.packets.slice(index);
      this.startTs = ts;
      this.startIndependent = true;
      this.sourceStartTs ??= ts;
      this.startPart(0, ts, true);
      return;
    }
    // Image clé reconnue après coup (analyse NAL) : la partie qu'elle ouvre est autonome.
    if (index === this.partStart) this.partIndependent = true;
    const target =
      this.segmentsSinceBreak === 0 || this.inFastStart(ts)
        ? this.options.firstTargetDurationS
        : this.options.targetDurationS;
    if (timestampDelta(this.startTs, ts) >= target * MPEG_CLOCK_HZ) this.cut(index, ts, true);
  }

  /** Publie les paquets [0, index) ; le segment suivant commence à `ts`. */
  private cut(index: number, ts: number, nextIndependent: boolean): void {
    if (this.startTs === null) return;
    if (this.partStartTs !== null) this.endPart(index, timestampDelta(this.partStartTs, ts));
    this.publish(this.packets.slice(0, index), timestampDelta(this.startTs, ts));
    this.packets = this.packets.slice(index);
    this.startTs = ts;
    this.startIndependent = nextIndependent;
    this.startPart(0, ts, nextIndependent);
  }

  private startPart(index: number, ts: number, independent: boolean): void {
    this.partStart = index;
    this.partStartTs = ts;
    this.partIndependent = independent;
  }

  /** Fin de partie à l'image `ts` si une image de plus dépasserait la cible. */
  private maybeEndPart(index: number, ts: number): void {
    if (this.options.partTargetS <= 0 || this.startTs === null || this.partStartTs === null) return;
    const ticks = timestampDelta(this.partStartTs, ts);
    if (ticks + this.frameTicks <= this.options.partTargetS * MPEG_CLOCK_HZ) return;
    this.endPart(index, ticks);
    this.startPart(index, ts, false);
  }

  private endPart(index: number, ticks: number): void {
    if (this.options.partTargetS <= 0 || index <= this.partStart || this.pat === null || this.pmt === null) {
      return;
    }
    const pat = Uint8Array.from(this.pat);
    const pmt = Uint8Array.from(this.pmt);
    setContinuityCounter(pat, 0, this.partPatCc);
    setContinuityCounter(pmt, 0, this.partPmtCc);
    this.partPatCc = (this.partPatCc + 1) & 0x0f;
    this.partPmtCc = (this.partPmtCc + 1) & 0x0f;
    const part: PartDraft = {
      data: withTables(pat, pmt, this.packets.slice(this.partStart, index)),
      durationS: ticks / MPEG_CLOCK_HZ,
      independent: this.partIndependent,
      discontinuity: this.nextDiscontinuity,
    };
    this.parts.push(part);
    this.emitPart(part);
  }

  private flushPartial(): void {
    if (this.startTs !== null && this.lastTs !== null) {
      const ticks = timestampDelta(this.startTs, this.lastTs) + this.frameTicks;
      if (this.partStartTs !== null) {
        this.endPart(this.packets.length, timestampDelta(this.partStartTs, this.lastTs) + this.frameTicks);
      }
      // Des parties déjà annoncées aux lecteurs : leur segment doit exister, même court.
      if (ticks >= this.options.minFlushDurationS * MPEG_CLOCK_HZ || this.parts.length > 0) {
        this.publish(this.packets, ticks);
      }
    }
    this.packets = [];
    this.startTs = null;
    this.pending = null;
    this.parts = [];
    this.partStartTs = null;
  }

  private publish(packets: Uint8Array[], ticks: number): void {
    if (this.pat === null || this.pmt === null || packets.length === 0) return;
    // Copies des tables en tête, avec nos propres compteurs de continuité : les tables de
    // l'amont sont retirées du corps, la suite reste donc continue d'un segment à l'autre.
    const pat = Uint8Array.from(this.pat);
    const pmt = Uint8Array.from(this.pmt);
    setContinuityCounter(pat, 0, this.patCc);
    setContinuityCounter(pmt, 0, this.pmtCc);
    this.patCc = (this.patCc + 1) & 0x0f;
    this.pmtCc = (this.pmtCc + 1) & 0x0f;
    const parts = this.parts;
    this.parts = [];
    this.emit({
      data: withTables(pat, pmt, packets),
      durationS: ticks / MPEG_CLOCK_HZ,
      independent: this.startIndependent,
      discontinuity: this.nextDiscontinuity,
      parts,
    });
    this.nextDiscontinuity = false;
    this.segmentsSinceBreak++;
  }
}

function withTables(pat: Uint8Array, pmt: Uint8Array, packets: readonly Uint8Array[]): Buffer {
  const data = Buffer.allocUnsafe((packets.length + 2) * TS_PACKET_SIZE);
  data.set(pat, 0);
  data.set(pmt, TS_PACKET_SIZE);
  packets.forEach((pkt, i) => {
    data.set(pkt, (i + 2) * TS_PACKET_SIZE);
  });
  return data;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

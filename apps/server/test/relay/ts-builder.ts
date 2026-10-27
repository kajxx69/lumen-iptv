/**
 * Fabrique de flux MPEG-TS synthétiques pour les tests du découpeur : chaque cas (GOP
 * long, absence de drapeau d'accès aléatoire, saut d'horodatage…) est construit à la
 * demande, sans dépendre de FFmpeg.
 */

export const PACKET = 188;
export const PMT_PID = 0x1000;
export const VIDEO_PID = 0x100;
export const AUDIO_PID = 0x101;
export const CLOCK = 90_000;
/** 25 images/s. */
export const FRAME_TICKS = 3600;
/** Trame AAC : 1024 échantillons à 48 kHz. */
export const AUDIO_FRAME_TICKS = 1920;

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC = 0x0f;
const VIDEO_STREAM_ID = 0xe0;
const AUDIO_STREAM_ID = 0xc0;
const MODULO = 2 ** 33;

export interface PacketOptions {
  pus?: boolean;
  rai?: boolean;
}

export class TsBuilder {
  private readonly cc = new Map<number, number>();

  constructor(
    readonly streams: { video: boolean; audio: boolean } = { video: true, audio: true },
    readonly pids = { pmt: PMT_PID, video: VIDEO_PID, audio: AUDIO_PID },
  ) {}

  packet(pid: number, payload: Uint8Array, opts: PacketOptions = {}): Uint8Array {
    const out = new Uint8Array(PACKET).fill(0xff);
    const cc = this.cc.get(pid) ?? 0;
    this.cc.set(pid, (cc + 1) & 0x0f);
    out[0] = 0x47;
    out[1] = (opts.pus === true ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    out[2] = pid & 0xff;
    const rai = opts.rai === true;
    if (!rai && payload.length === PACKET - 4) {
      out[3] = 0x10 | cc;
      out.set(payload, 4);
      return out;
    }
    // Champ d'adaptation : porte le drapeau d'accès aléatoire et le bourrage.
    const afLength = PACKET - 5 - payload.length;
    if (afLength < (rai ? 1 : 0)) throw new Error('charge utile trop longue pour ce paquet');
    out[3] = 0x30 | cc;
    out[4] = afLength;
    if (afLength > 0) out[5] = rai ? 0x40 : 0x00;
    out.set(payload, 5 + afLength);
    return out;
  }

  pat(): Uint8Array {
    const pmt = this.pids.pmt;
    const section = [0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmt >> 8), pmt & 0xff];
    return this.packet(0, Uint8Array.from([0x00, ...section, 0, 0, 0, 0]), { pus: true });
  }

  pmt(): Uint8Array {
    const es: number[] = [];
    if (this.streams.video)
      es.push(STREAM_TYPE_H264, 0xe0 | (this.pids.video >> 8), this.pids.video & 0xff, 0xf0, 0);
    if (this.streams.audio)
      es.push(STREAM_TYPE_AAC, 0xe0 | (this.pids.audio >> 8), this.pids.audio & 0xff, 0xf0, 0);
    const pcr = this.streams.video ? this.pids.video : this.pids.audio;
    const length = 9 + es.length + 4;
    const section = [
      0x02,
      0xb0,
      length,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0xe0 | (pcr >> 8),
      pcr & 0xff,
      0xf0,
      0x00,
      ...es,
    ];
    return this.packet(this.pids.pmt, Uint8Array.from([0x00, ...section, 0, 0, 0, 0]), { pus: true });
  }

  /** Un PES complet découpé en paquets ; `rai` marque le premier paquet. */
  pes(pid: number, streamId: number, pts: number, data: Uint8Array, rai = false): Uint8Array[] {
    const header = [0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5, ...timestamp(0x2, pts)];
    const body = Uint8Array.from([...header, ...data]);
    const packets: Uint8Array[] = [];
    let off = 0;
    let first = true;
    while (off < body.length) {
      const room = first && rai ? PACKET - 6 : PACKET - 4;
      const chunk = body.subarray(off, off + room);
      packets.push(this.packet(pid, chunk, { pus: first, rai: first && rai }));
      off += chunk.length;
      first = false;
    }
    return packets;
  }

  videoFrame(pts: number, key: boolean, opts: { rai?: boolean } = {}): Uint8Array[] {
    return this.pes(
      this.pids.video,
      VIDEO_STREAM_ID,
      pts,
      key ? IDR_ACCESS_UNIT : DELTA_ACCESS_UNIT,
      key && (opts.rai ?? true),
    );
  }

  audioFrame(pts: number): Uint8Array[] {
    return this.pes(this.pids.audio, AUDIO_STREAM_ID, pts, AAC_FRAME);
  }
}

export interface StreamSpec {
  durationS: number;
  startPts?: number;
  gopS?: number;
  /** Drapeau random_access_indicator sur les images clés (FFmpeg le pose ; d'autres non). */
  rai?: boolean;
  /** Première image vidéo à l'intérieur d'un GOP : les images avant la première clé sont inutilisables. */
  startFrameInGop?: number;
  video?: boolean;
  audio?: boolean;
  /** PAT/PMT répétées toutes les N images (≈ 0,5 s par défaut, comme un encodeur de diffusion). */
  psiEveryFrames?: number;
  builder?: TsBuilder;
}

/** Flux complet, audio et vidéo entrelacés par horodatage, PAT/PMT répétées. */
export function buildStream(spec: StreamSpec): Uint8Array {
  const video = spec.video ?? true;
  const audio = spec.audio ?? true;
  const b = spec.builder ?? new TsBuilder({ video, audio });
  const start = spec.startPts ?? 900_000;
  const gopFrames = Math.round(((spec.gopS ?? 2) * CLOCK) / FRAME_TICKS);
  const psiEvery = spec.psiEveryFrames ?? 12;
  const endTicks = spec.durationS * CLOCK;
  const out: Uint8Array[] = [b.pat(), b.pmt()];
  let v = 0;
  let a = 0;
  let frame = spec.startFrameInGop ?? 0;
  for (;;) {
    const vt = video ? v * FRAME_TICKS : Infinity;
    const at = audio ? a * AUDIO_FRAME_TICKS : Infinity;
    const t = Math.min(vt, at);
    if (t >= endTicks) break;
    if (vt <= at) {
      if (frame % psiEvery === 0) out.push(b.pat(), b.pmt());
      out.push(...b.videoFrame((start + vt) % MODULO, frame % gopFrames === 0, { rai: spec.rai ?? true }));
      v++;
      frame++;
    } else {
      if (!video && a % psiEvery === 0) out.push(b.pat(), b.pmt());
      out.push(...b.audioFrame((start + at) % MODULO));
      a++;
    }
  }
  return concat(out);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function nullPacket(): Uint8Array {
  const out = new Uint8Array(PACKET).fill(0xff);
  out.set([0x47, 0x1f, 0xff, 0x10]);
  return out;
}

export const pidOf = (buf: Uint8Array, packetIndex: number): number => {
  const off = packetIndex * PACKET;
  return (((buf[off + 1] ?? 0) & 0x1f) << 8) | (buf[off + 2] ?? 0);
};

export const ccOf = (buf: Uint8Array, packetIndex: number): number =>
  (buf[packetIndex * PACKET + 3] ?? 0) & 0x0f;

export const isPayloadStart = (buf: Uint8Array, packetIndex: number): boolean =>
  ((buf[packetIndex * PACKET + 1] ?? 0) & 0x40) !== 0;

/** PTS des débuts de PES vidéo d'un segment, dans l'ordre. */
export function videoPts(buf: Uint8Array, videoPid = VIDEO_PID): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length / PACKET; i++) {
    if (pidOf(buf, i) !== videoPid || !isPayloadStart(buf, i)) continue;
    const off = i * PACKET;
    const hasAf = ((buf[off + 3] ?? 0) & 0x20) !== 0;
    const p = off + 4 + (hasAf ? 1 + (buf[off + 4] ?? 0) : 0);
    out.push(readTimestamp(buf, p + 9));
  }
  return out;
}

/** Vrai si le premier PES vidéo du segment est une image IDR. */
export function startsWithIdr(buf: Uint8Array, videoPid = VIDEO_PID): boolean {
  for (let i = 0; i < buf.length / PACKET; i++) {
    if (pidOf(buf, i) !== videoPid) continue;
    if (!isPayloadStart(buf, i)) return false;
    const off = i * PACKET;
    const hasAf = ((buf[off + 3] ?? 0) & 0x20) !== 0;
    const p = off + 4 + (hasAf ? 1 + (buf[off + 4] ?? 0) : 0);
    // Accès unitaire IDR : en-tête PES (14 octets), délimiteur (6 octets), puis SPS (type 7).
    return ((buf[p + 14 + 6 + 4] ?? 0) & 0x1f) === 7;
  }
  return false;
}

function timestamp(prefix: number, value: number): number[] {
  const ts = ((value % MODULO) + MODULO) % MODULO;
  const high = Math.floor(ts / 2 ** 30) & 0x07;
  const low = ts % 2 ** 30;
  return [
    (prefix << 4) | (high << 1) | 1,
    (low >>> 22) & 0xff,
    (((low >>> 15) & 0x7f) << 1) | 1,
    (low >>> 7) & 0xff,
    ((low & 0x7f) << 1) | 1,
  ];
}

function readTimestamp(buf: Uint8Array, at: number): number {
  const high = ((buf[at] ?? 0) >> 1) & 0x07;
  const low =
    ((buf[at + 1] ?? 0) << 22) |
    (((buf[at + 2] ?? 0) >> 1) << 15) |
    ((buf[at + 3] ?? 0) << 7) |
    ((buf[at + 4] ?? 0) >> 1);
  return high * 2 ** 30 + low;
}

const START = [0, 0, 0, 1];
/**
 * Accès unitaire IDR réaliste : délimiteur, SPS, PPS et un long SEI (x264 y écrit ses
 * réglages) qui repousse l'IDR au-delà du premier paquet TS.
 */
// prettier-ignore
const IDR_ACCESS_UNIT = Uint8Array.from([
  ...START, 0x09, 0xf0,
  ...START, 0x67, 0x4d, 0x40, 0x1e, 0x95, 0xa0,
  ...START, 0x68, 0xee, 0x3c, 0x80,
  ...START, 0x06, 0x05, ...new Array<number>(400).fill(0x55), 0x80,
  ...START, 0x65, 0x88, 0x84, ...new Array<number>(600).fill(0x2a),
]);
// prettier-ignore
const DELTA_ACCESS_UNIT = Uint8Array.from([
  ...START, 0x09, 0x30,
  ...START, 0x41, 0x9a, 0x02, ...new Array<number>(300).fill(0x2a),
]);
const AAC_FRAME = Uint8Array.from([
  0xff,
  0xf1,
  0x50,
  0x80,
  0x0f,
  0xff,
  0xfc,
  ...new Array<number>(100).fill(0x11),
]);

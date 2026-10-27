/**
 * Lecture minimale de MPEG-TS (ISO 13818-1) pour le relais : en-têtes de paquets, tables
 * PAT/PMT, horodatages PES et repérage des images clés. Rien n'est décodé : le relais
 * découpe et recopie les octets tels quels.
 */

export const TS_PACKET_SIZE = 188;
export const TS_SYNC_BYTE = 0x47;
export const PAT_PID = 0x0000;
export const NULL_PID = 0x1fff;
export const MPEG_CLOCK_HZ = 90_000;
const TIMESTAMP_MODULO = 2 ** 33;

const PAT_TABLE_ID = 0x00;
const PMT_TABLE_ID = 0x02;
/** Longueur de section après le champ section_length : en-tête étendu (5) puis CRC (4). */
const PSI_CRC_BYTES = 4;
const PAT_HEADER_BYTES = 8;
const PMT_HEADER_BYTES = 12;

export type VideoCodec = 'h264' | 'hevc' | 'mpeg2' | 'other';

export interface ProgramStreams {
  videoPid: number | null;
  videoCodec: VideoCodec | null;
  audioPids: number[];
}

/** Types de flux élémentaires (ISO 13818-1 tableau 2-34 et usages DVB/ATSC courants). */
const VIDEO_STREAM_TYPES: Record<number, VideoCodec> = {
  0x01: 'mpeg2',
  0x02: 'mpeg2',
  0x10: 'other', // MPEG-4 Part 2
  0x1b: 'h264',
  0x24: 'hevc',
  0x42: 'other', // AVS
};
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);

const byteAt = (buf: Uint8Array, at: number): number => buf[at] ?? 0;

export const packetPid = (buf: Uint8Array, off: number): number =>
  ((byteAt(buf, off + 1) & 0x1f) << 8) | byteAt(buf, off + 2);

export const payloadUnitStart = (buf: Uint8Array, off: number): boolean =>
  (byteAt(buf, off + 1) & 0x40) !== 0;

const hasAdaptation = (buf: Uint8Array, off: number): boolean => (byteAt(buf, off + 3) & 0x20) !== 0;
export const hasPayload = (buf: Uint8Array, off: number): boolean => (byteAt(buf, off + 3) & 0x10) !== 0;

/** Drapeau random_access_indicator : l'encodeur signale un point d'entrée (image clé). */
export function randomAccess(buf: Uint8Array, off: number): boolean {
  if (!hasAdaptation(buf, off) || byteAt(buf, off + 4) === 0) return false;
  return (byteAt(buf, off + 5) & 0x40) !== 0;
}

/** Début de la charge utile, ou -1 si le paquet n'en a pas (ou s'il est malformé). */
export function payloadOffset(buf: Uint8Array, off: number): number {
  if (!hasPayload(buf, off)) return -1;
  const start = off + 4 + (hasAdaptation(buf, off) ? 1 + byteAt(buf, off + 4) : 0);
  return start < off + TS_PACKET_SIZE ? start : -1;
}

export function setContinuityCounter(buf: Uint8Array, off: number, cc: number): void {
  buf[off + 3] = (byteAt(buf, off + 3) & 0xf0) | (cc & 0x0f);
}

const wrap33 = (value: number): number => ((value % TIMESTAMP_MODULO) + TIMESTAMP_MODULO) % TIMESTAMP_MODULO;

/** Écart signé le plus court entre deux horodatages 33 bits (gère le rebouclage). */
export function timestampDelta(from: number, to: number): number {
  const d = wrap33(to - from);
  return d >= TIMESTAMP_MODULO / 2 ? d - TIMESTAMP_MODULO : d;
}

function readTimestamp(buf: Uint8Array, at: number): number {
  const high = (byteAt(buf, at) >> 1) & 0x07;
  const low =
    (byteAt(buf, at + 1) << 22) |
    ((byteAt(buf, at + 2) >> 1) << 15) |
    (byteAt(buf, at + 3) << 7) |
    (byteAt(buf, at + 4) >> 1);
  return high * 2 ** 30 + low;
}

export interface PesHeader {
  /** DTS s'il existe, sinon PTS : l'horodatage qui croît dans l'ordre de décodage. */
  decodeTs: number | null;
  /** Début des données élémentaires dans le paquet. */
  dataOffset: number;
}

/** En-tête PES commençant à `p` (début de charge utile d'un paquet à payload_unit_start). */
export function readPesHeader(buf: Uint8Array, p: number, packetEnd: number): PesHeader | null {
  if (p + 9 > packetEnd) return null;
  if (byteAt(buf, p) !== 0 || byteAt(buf, p + 1) !== 0 || byteAt(buf, p + 2) !== 1) return null;
  const flags = (byteAt(buf, p + 7) >> 6) & 0b11;
  const dataOffset = p + 9 + byteAt(buf, p + 8);
  if (flags === 0b10 && p + 14 <= packetEnd) return { decodeTs: readTimestamp(buf, p + 9), dataOffset };
  if (flags === 0b11 && p + 19 <= packetEnd) return { decodeTs: readTimestamp(buf, p + 14), dataOffset };
  return { decodeTs: null, dataOffset };
}

/** Début de section PSI (après le pointer_field), ou -1. */
function sectionStart(buf: Uint8Array, off: number): number {
  const p = payloadOffset(buf, off);
  if (p < 0 || !payloadUnitStart(buf, off)) return -1;
  const start = p + 1 + byteAt(buf, p);
  return start < off + TS_PACKET_SIZE ? start : -1;
}

const sectionEnd = (buf: Uint8Array, s: number, packetEnd: number): number =>
  Math.min(s + 3 + (((byteAt(buf, s + 1) & 0x0f) << 8) | byteAt(buf, s + 2)) - PSI_CRC_BYTES, packetEnd);

/** PID de la PMT du premier programme d'une PAT tenant dans un paquet. */
export function parsePat(buf: Uint8Array, off: number): number | null {
  const s = sectionStart(buf, off);
  if (s < 0 || byteAt(buf, s) !== PAT_TABLE_ID) return null;
  const end = sectionEnd(buf, s, off + TS_PACKET_SIZE);
  for (let i = s + PAT_HEADER_BYTES; i + 4 <= end; i += 4) {
    const program = (byteAt(buf, i) << 8) | byteAt(buf, i + 1);
    // Le programme 0 désigne la table réseau (NIT), pas un service.
    if (program !== 0) return ((byteAt(buf, i + 2) & 0x1f) << 8) | byteAt(buf, i + 3);
  }
  return null;
}

/** Flux élémentaires d'une PMT tenant dans un paquet. */
export function parsePmt(buf: Uint8Array, off: number): ProgramStreams | null {
  const s = sectionStart(buf, off);
  if (s < 0 || byteAt(buf, s) !== PMT_TABLE_ID) return null;
  const end = sectionEnd(buf, s, off + TS_PACKET_SIZE);
  const programInfo = ((byteAt(buf, s + 10) & 0x0f) << 8) | byteAt(buf, s + 11);
  const out: ProgramStreams = { videoPid: null, videoCodec: null, audioPids: [] };
  for (let i = s + PMT_HEADER_BYTES + programInfo; i + 5 <= end;) {
    const type = byteAt(buf, i);
    const pid = ((byteAt(buf, i + 1) & 0x1f) << 8) | byteAt(buf, i + 2);
    const codec = VIDEO_STREAM_TYPES[type];
    if (codec !== undefined && out.videoPid === null) {
      out.videoPid = pid;
      out.videoCodec = codec;
    } else if (AUDIO_STREAM_TYPES.has(type)) {
      out.audioPids.push(pid);
    }
    i += 5 + (((byteAt(buf, i + 3) & 0x0f) << 8) | byteAt(buf, i + 4));
  }
  return out;
}

/** Au-delà, une image dont le début n'a révélé aucune unité codée est traitée comme différentielle. */
const KEYFRAME_SCAN_LIMIT_BYTES = 64 * 1024;

/**
 * Détermine si une image vidéo est une image clé en lisant ses unités NAL (H.264, HEVC)
 * ou ses codes de démarrage (MPEG-2), au fil des paquets qui la portent. Sert quand
 * l'amont ne pose pas le drapeau random_access_indicator.
 */
export class KeyframeScanner {
  private tail: number[] = [];
  private scanned = 0;

  constructor(private readonly codec: VideoCodec) {}

  /** Renvoie true (clé), false (différentielle) ou null (pas encore décidé). */
  feed(bytes: Uint8Array): boolean | null {
    const data = this.tail.length === 0 ? bytes : Uint8Array.from([...this.tail, ...bytes]);
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
      const verdict = this.classify(byteAt(data, i + 3));
      if (verdict !== null) return verdict;
    }
    this.scanned += bytes.length;
    if (this.scanned > KEYFRAME_SCAN_LIMIT_BYTES) return false;
    this.tail = Array.from(data.subarray(Math.max(0, data.length - 3)));
    return null;
  }

  private classify(header: number): boolean | null {
    switch (this.codec) {
      case 'h264': {
        const type = header & 0x1f;
        // Première unité codée de l'image : IDR (5) ou tranche ordinaire (1 à 4).
        if (type === 5) return true;
        return type >= 1 && type <= 4 ? false : null;
      }
      case 'hevc': {
        const type = (header >> 1) & 0x3f;
        // Points d'accès aléatoire intra (BLA, IDR, CRA : 16 à 21).
        if (type >= 16 && type <= 21) return true;
        return type <= 31 ? false : null;
      }
      case 'mpeg2':
        // En-tête de séquence (B3) ou de GOP (B8) avant l'image : point d'entrée.
        if (header === 0xb3 || header === 0xb8) return true;
        return header === 0x00 ? false : null;
      case 'other':
        return false;
    }
  }
}

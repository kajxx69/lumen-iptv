import { FakePortalError } from '../errors.js';

export const TS_PACKET_SIZE = 188;
export const TS_SYNC_BYTE = 0x47;
/** Les PTS, DTS et la base PCR sont des compteurs 33 bits à 90 kHz. */
export const TIMESTAMP_MODULO = 2 ** 33;
export const MPEG_CLOCK_HZ = 90_000;
export const MPEG_TICKS_PER_MS = MPEG_CLOCK_HZ / 1000;

const ADAPTATION_FLAG = 0b10;
const PAYLOAD_FLAG = 0b01;
const PCR_FLAG = 0x10;
const PTS_ONLY = 0b10;
const PTS_AND_DTS = 0b11;
// Flux PES sans en-tête optionnel (ISO 13818-1, tableau 2-21) : ni PTS ni DTS.
const STREAM_IDS_WITHOUT_HEADER = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

export interface PacketHeader {
  pid: number;
  payloadUnitStart: boolean;
  hasAdaptation: boolean;
  hasPayload: boolean;
  continuityCounter: number;
  /** Position absolue du début de la charge utile dans le tampon. */
  payloadOffset: number;
}

export interface PesTimestamps {
  streamId: number;
  ptsAt: number | null;
  dtsAt: number | null;
}

export const wrap33 = (value: number): number =>
  ((value % TIMESTAMP_MODULO) + TIMESTAMP_MODULO) % TIMESTAMP_MODULO;

/** Écart signé le plus court entre deux horodatages 33 bits (gère le rebouclage). */
export function timestampDelta(from: number, to: number): number {
  const d = wrap33(to - from);
  return d >= TIMESTAMP_MODULO / 2 ? d - TIMESTAMP_MODULO : d;
}

export const isVideoStream = (streamId: number): boolean => streamId >= 0xe0 && streamId <= 0xef;
export const isAudioStream = (streamId: number): boolean => streamId >= 0xc0 && streamId <= 0xdf;

export function assertAligned(buf: Uint8Array): void {
  if (buf.length % TS_PACKET_SIZE !== 0) {
    throw new FakePortalError('TS_INVALID', `taille ${buf.length} non multiple de ${TS_PACKET_SIZE}`);
  }
  for (let off = 0; off < buf.length; off += TS_PACKET_SIZE) {
    if (buf[off] !== TS_SYNC_BYTE) {
      throw new FakePortalError('TS_INVALID', `octet de synchronisation absent à ${off}`);
    }
  }
}

const byteAt = (buf: Uint8Array, at: number): number => buf[at] ?? 0;

export function readHeader(buf: Uint8Array, off: number): PacketHeader {
  const b1 = byteAt(buf, off + 1);
  const b3 = byteAt(buf, off + 3);
  const afc = (b3 >> 4) & 0b11;
  const hasAdaptation = (afc & ADAPTATION_FLAG) !== 0;
  const adaptationLength = hasAdaptation ? byteAt(buf, off + 4) : 0;
  return {
    pid: ((b1 & 0x1f) << 8) | byteAt(buf, off + 2),
    payloadUnitStart: (b1 & 0x40) !== 0,
    hasAdaptation,
    hasPayload: (afc & PAYLOAD_FLAG) !== 0,
    continuityCounter: b3 & 0x0f,
    payloadOffset: off + 4 + (hasAdaptation ? 1 + adaptationLength : 0),
  };
}

export function setContinuityCounter(buf: Uint8Array, off: number, cc: number): void {
  buf[off + 3] = (byteAt(buf, off + 3) & 0xf0) | (cc & 0x0f);
}

/** Position de la base PCR dans le paquet, ou null s'il n'en porte pas. */
export function pcrAt(buf: Uint8Array, off: number, header: PacketHeader): number | null {
  if (!header.hasAdaptation) return null;
  const adaptationLength = byteAt(buf, off + 4);
  if (adaptationLength < 7) return null;
  return (byteAt(buf, off + 5) & PCR_FLAG) !== 0 ? off + 6 : null;
}

export function readPcrBase(buf: Uint8Array, at: number): number {
  return (
    byteAt(buf, at) * 2 ** 25 +
    ((byteAt(buf, at + 1) << 17) |
      (byteAt(buf, at + 2) << 9) |
      (byteAt(buf, at + 3) << 1) |
      (byteAt(buf, at + 4) >> 7))
  );
}

export function writePcrBase(buf: Uint8Array, at: number, value: number): void {
  const base = wrap33(value);
  const rest = base % 2 ** 25;
  buf[at] = Math.floor(base / 2 ** 25) & 0xff;
  buf[at + 1] = (rest >>> 17) & 0xff;
  buf[at + 2] = (rest >>> 9) & 0xff;
  buf[at + 3] = (rest >>> 1) & 0xff;
  buf[at + 4] = ((rest & 1) << 7) | (byteAt(buf, at + 4) & 0x7f);
}

export function readTimestamp(buf: Uint8Array, at: number): number {
  const high = (byteAt(buf, at) >> 1) & 0x07;
  const low =
    (byteAt(buf, at + 1) << 22) |
    ((byteAt(buf, at + 2) >> 1) << 15) |
    (byteAt(buf, at + 3) << 7) |
    (byteAt(buf, at + 4) >> 1);
  return high * 2 ** 30 + low;
}

export function writeTimestamp(buf: Uint8Array, at: number, value: number): void {
  const ts = wrap33(value);
  const high = Math.floor(ts / 2 ** 30) & 0x07;
  const low = ts % 2 ** 30;
  buf[at] = (byteAt(buf, at) & 0xf0) | (high << 1) | 1;
  buf[at + 1] = (low >>> 22) & 0xff;
  buf[at + 2] = (((low >>> 15) & 0x7f) << 1) | 1;
  buf[at + 3] = (low >>> 7) & 0xff;
  buf[at + 4] = ((low & 0x7f) << 1) | 1;
}

/** Repère PTS/DTS d'un en-tête PES commençant dans ce paquet. */
export function pesTimestampsAt(buf: Uint8Array, off: number, header: PacketHeader): PesTimestamps | null {
  if (!header.payloadUnitStart || !header.hasPayload) return null;
  const p = header.payloadOffset;
  const packetEnd = off + TS_PACKET_SIZE;
  if (p + 9 > packetEnd) return null;
  if (byteAt(buf, p) !== 0 || byteAt(buf, p + 1) !== 0 || byteAt(buf, p + 2) !== 1) return null;
  const streamId = byteAt(buf, p + 3);
  if (STREAM_IDS_WITHOUT_HEADER.has(streamId)) return { streamId, ptsAt: null, dtsAt: null };
  const flags = (byteAt(buf, p + 7) >> 6) & 0b11;
  const ptsAt = flags === PTS_ONLY || flags === PTS_AND_DTS ? p + 9 : null;
  const dtsAt = flags === PTS_AND_DTS ? p + 14 : null;
  if ((dtsAt ?? ptsAt ?? p) + 5 > packetEnd) return null;
  return { streamId, ptsAt, dtsAt };
}

export interface PesInfo {
  packetIndex: number;
  pid: number;
  streamId: number;
  pts: number | null;
  dts: number | null;
}

/** Liste les en-têtes PES d'un tampon aligné : outil d'analyse pour les tests et le diagnostic. */
export function listPes(buf: Uint8Array): PesInfo[] {
  const out: PesInfo[] = [];
  for (let off = 0, i = 0; off + TS_PACKET_SIZE <= buf.length; off += TS_PACKET_SIZE, i++) {
    if (buf[off] !== TS_SYNC_BYTE) continue;
    const header = readHeader(buf, off);
    const pes = pesTimestampsAt(buf, off, header);
    if (pes === null) continue;
    out.push({
      packetIndex: i,
      pid: header.pid,
      streamId: pes.streamId,
      pts: pes.ptsAt === null ? null : readTimestamp(buf, pes.ptsAt),
      dts: pes.dtsAt === null ? null : readTimestamp(buf, pes.dtsAt),
    });
  }
  return out;
}

/**
 * Retire les PES (en-tête et paquets de continuation) pour lesquels `shouldDrop` est vrai.
 * Les compteurs de continuité ne sont pas corrigés : à faire ensuite si nécessaire.
 */
export function dropPes(
  buf: Uint8Array,
  shouldDrop: (pes: { streamId: number; pts: number | null }) => boolean,
): Buffer {
  const kept: Uint8Array[] = [];
  const dropping = new Map<number, boolean>();
  for (let off = 0; off + TS_PACKET_SIZE <= buf.length; off += TS_PACKET_SIZE) {
    const header = readHeader(buf, off);
    const pes = pesTimestampsAt(buf, off, header);
    if (pes !== null) {
      dropping.set(
        header.pid,
        shouldDrop({
          streamId: pes.streamId,
          pts: pes.ptsAt === null ? null : readTimestamp(buf, pes.ptsAt),
        }),
      );
    } else if (header.payloadUnitStart) {
      dropping.set(header.pid, false);
    }
    if (dropping.get(header.pid) !== true) kept.push(buf.subarray(off, off + TS_PACKET_SIZE));
  }
  return Buffer.concat(kept);
}

/**
 * Renumérote les compteurs de continuité d'un flux TS continu. Indispensable quand le
 * flux enchaîne des segments de boucles ou de sources différentes.
 */
export class ContinuityRewriter {
  private readonly next = new Map<number, number>();

  rewrite(buf: Uint8Array): void {
    for (let off = 0; off + TS_PACKET_SIZE <= buf.length; off += TS_PACKET_SIZE) {
      const header = readHeader(buf, off);
      if (header.pid === 0x1fff) continue;
      const expected = this.next.get(header.pid);
      if (!header.hasPayload) {
        // Sans charge utile, le compteur répète la dernière valeur émise.
        if (expected !== undefined) setContinuityCounter(buf, off, (expected + 15) & 0x0f);
        continue;
      }
      const cc = expected ?? header.continuityCounter;
      setContinuityCounter(buf, off, cc);
      this.next.set(header.pid, (cc + 1) & 0x0f);
    }
  }
}

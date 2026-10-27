/** Lecture des playlists HLS amont (RFC 8216), réduite à ce dont le relais a besoin. */

export interface MediaSegment {
  seq: number;
  durationS: number;
  discontinuity: boolean;
  /** URI absolue, résolue contre l'URL de la playlist. */
  uri: string;
}

export interface MediaPlaylist {
  kind: 'media';
  targetDurationS: number;
  mediaSequence: number;
  endList: boolean;
  /** Segments fMP4 (EXT-X-MAP) : pas encore relayés, la source est alors écartée. */
  initSegment: boolean;
  segments: MediaSegment[];
}

export interface Variant {
  uri: string;
  bandwidth: number;
}

export interface MasterPlaylist {
  kind: 'master';
  variants: Variant[];
}

export type ParsedPlaylist = MediaPlaylist | MasterPlaylist;

export class PlaylistError extends Error {
  override readonly name = 'PlaylistError';
}

const attribute = (line: string, name: string): string | undefined =>
  new RegExp(`(?:^|[:,])${name}=("[^"]*"|[^,]*)`).exec(line)?.[1]?.replace(/^"|"$/g, '');

const numberAfter = (line: string, tag: string): number => Number.parseFloat(line.slice(tag.length + 1));

export function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines[0] !== '#EXTM3U') throw new PlaylistError('réponse amont qui n’est pas une playlist HLS');
  const resolve = (uri: string): string => new URL(uri, baseUrl).href;

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: Variant[] = [];
    let bandwidth: number | null = null;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        bandwidth = Number(attribute(line, 'BANDWIDTH') ?? 0);
      } else if (!line.startsWith('#') && bandwidth !== null) {
        variants.push({ uri: resolve(line), bandwidth });
        bandwidth = null;
      }
    }
    return { kind: 'master', variants };
  }

  const out: MediaPlaylist = {
    kind: 'media',
    targetDurationS: 0,
    mediaSequence: 0,
    endList: false,
    initSegment: false,
    segments: [],
  };
  let duration: number | null = null;
  let discontinuity = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:'))
      out.targetDurationS = numberAfter(line, '#EXT-X-TARGETDURATION');
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
      out.mediaSequence = numberAfter(line, '#EXT-X-MEDIA-SEQUENCE');
    else if (line.startsWith('#EXTINF:')) duration = numberAfter(line, '#EXTINF');
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line === '#EXT-X-ENDLIST') out.endList = true;
    else if (line.startsWith('#EXT-X-MAP')) out.initSegment = true;
    else if (!line.startsWith('#') && duration !== null) {
      out.segments.push({
        seq: out.mediaSequence + out.segments.length,
        durationS: duration,
        discontinuity,
        uri: resolve(line),
      });
      duration = null;
      discontinuity = false;
    }
  }
  return out;
}

/**
 * Variante relayée : la meilleure qualité. La descente de qualité sur réseau lent se fera
 * côté relais (plusieurs variantes) quand le transcodage adaptatif arrivera.
 */
export const pickVariant = (variants: readonly Variant[]): Variant | undefined =>
  variants.reduce<Variant | undefined>(
    (best, v) => (best === undefined || v.bandwidth > best.bandwidth ? v : best),
    undefined,
  );

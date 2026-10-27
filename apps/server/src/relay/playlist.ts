import type { RelaySegment } from './segment-window.js';

export interface PlaylistInput {
  mediaSequence: number;
  discontinuitySequence: number;
  segments: readonly RelaySegment[];
  targetDurationS: number;
}

/**
 * Playlist HLS en direct du relais (RFC 8216). Chaque segment porte son horodatage
 * mural : repère commun à toutes les sources pour la lecture différée et les mesures.
 */
export function renderPlaylist(input: PlaylistInput, uri: (seq: number) => string): string {
  // La durée cible ne doit jamais être inférieure à la durée arrondie d'un segment.
  const longest = input.segments.reduce((m, s) => Math.max(m, Math.round(s.durationS)), 0);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.max(input.targetDurationS, longest)}`,
    `#EXT-X-MEDIA-SEQUENCE:${input.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${input.discontinuitySequence}`,
  ];
  for (const s of input.segments) {
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.programDateTimeMs).toISOString()}`);
    lines.push(`#EXTINF:${s.durationS.toFixed(3)},`);
    lines.push(uri(s.seq));
  }
  return `${lines.join('\n')}\n`;
}

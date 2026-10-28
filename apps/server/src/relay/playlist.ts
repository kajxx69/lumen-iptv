import type { RelayPart, RelaySegment } from './segment-window.js';

export interface PlaylistInput {
  mediaSequence: number;
  discontinuitySequence: number;
  segments: readonly RelaySegment[];
  targetDurationS: number;
  /**
   * Rechargement bloquant (RFC 8216bis §6.2.5.2) : le lecteur demande « le segment N » et la
   * réponse part dès qu'il existe, au lieu d'interroger toutes les 3 s. HOLD-BACK : retard
   * visé sur le direct au démarrage (au moins trois durées cibles).
   */
  blockingReload?: { holdBackS: number };
  /**
   * « Direct au plus près » (LL-HLS) : parties de segment annoncées, retard visé
   * PART-HOLD-BACK, partie suivante en indice de préchargement.
   */
  lowLatency?: {
    partTargetS: number;
    partHoldBackS: number;
    /** Parties déjà publiées du segment en cours. */
    pendingParts: readonly RelayPart[];
    nextSeq: number;
  };
}

/** URI d'un segment, ou d'une de ses parties. */
export type SegmentUri = (seq: number, part?: number) => string;

function partLines(seq: number, parts: readonly RelayPart[], uri: SegmentUri): string[] {
  return parts.map(
    (p, i) =>
      `#EXT-X-PART:DURATION=${p.durationS.toFixed(3)},URI="${uri(seq, i)}"${p.independent ? ',INDEPENDENT=YES' : ''}`,
  );
}

/**
 * Playlist HLS en direct du relais (RFC 8216). Chaque segment porte son horodatage
 * mural : repère commun à toutes les sources pour la lecture différée et les mesures.
 */
export function renderPlaylist(input: PlaylistInput, uri: SegmentUri): string {
  // La durée cible ne doit jamais être inférieure à la durée arrondie d'un segment.
  const longest = input.segments.reduce((m, s) => Math.max(m, Math.round(s.durationS)), 0);
  const ll = input.lowLatency;
  const lines = [
    '#EXTM3U',
    // Les parties de segment (EXT-X-PART) relèvent de la version 6 et suivantes.
    ll === undefined ? '#EXT-X-VERSION:3' : '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${Math.max(input.targetDurationS, longest)}`,
    `#EXT-X-MEDIA-SEQUENCE:${input.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${input.discontinuitySequence}`,
  ];
  if (ll !== undefined) {
    lines.push(`#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${ll.partHoldBackS.toFixed(3)}`);
    lines.push(`#EXT-X-PART-INF:PART-TARGET=${ll.partTargetS.toFixed(3)}`);
  } else if (input.blockingReload !== undefined) {
    lines.push(
      `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,HOLD-BACK=${input.blockingReload.holdBackS.toFixed(3)}`,
    );
  }
  for (const s of input.segments) {
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.programDateTimeMs).toISOString()}`);
    if (ll !== undefined) lines.push(...partLines(s.seq, s.parts, uri));
    lines.push(`#EXTINF:${s.durationS.toFixed(3)},`);
    lines.push(uri(s.seq));
  }
  if (ll !== undefined) {
    // Segment en cours : ses parties déjà parues, puis la suivante en indice de préchargement.
    const first = ll.pendingParts[0];
    if (first?.discontinuity === true && input.segments.length > 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(...partLines(ll.nextSeq, ll.pendingParts, uri));
    lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${uri(ll.nextSeq, ll.pendingParts.length)}"`);
  }
  return `${lines.join('\n')}\n`;
}

import type { EpisodeDto, SeasonDto } from '@lumen/protocol';

/**
 * Le serveur garde au moins 30 s derrière le dernier segment demandé ; 20 s derrière la
 * position de lecture sont donc toujours encore là. Au-delà, un retour arrière relance la
 * lecture à la bonne position plutôt que de risquer un segment déjà libéré.
 */
export const SERVER_BEHIND_SAFE_S = 20;
/** Une lecture qui s'arrête plus tôt que cela avant la fin n'est pas finie : elle reprend seule. */
export const END_EARLY_TOLERANCE_S = 10;
/** Petite marge sur les bords d'une zone chargée : le lecteur y arrive sans attendre. */
const BUFFERED_EDGE_S = 0.25;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** Zone (temps vidéo) annoncée par la playlist. */
export interface PlaylistRange {
  start: number;
  end: number;
}

export interface SeekContext {
  /** Position dans le film = temps de la vidéo + `offsetS`. */
  offsetS: number;
  currentTime: number;
  /** Zones déjà chargées par le lecteur (temps vidéo). */
  buffered: readonly (readonly [number, number])[];
  playlist: PlaylistRange | null;
}

export type SeekPlan = { kind: 'local'; currentTime: number } | { kind: 'restart'; startS: number };

/**
 * Où aller pour atteindre `targetS` dans le film : dans ce que le lecteur a déjà, ou que le
 * serveur a encore, on se déplace sans rien relancer ; sinon, une nouvelle lecture part
 * de cette position (le serveur relit le fichier à partir de l'image clé la plus proche).
 */
export function seekPlan(targetS: number, ctx: SeekContext): SeekPlan {
  const t = targetS - ctx.offsetS;
  const inBuffer = ctx.buffered.some(([a, b]) => t >= a - BUFFERED_EDGE_S && t <= b + BUFFERED_EDGE_S);
  if (inBuffer) return { kind: 'local', currentTime: t };
  const p = ctx.playlist;
  if (p !== null && t >= p.start && t <= p.end && t >= ctx.currentTime - SERVER_BEHIND_SAFE_S) {
    return { kind: 'local', currentTime: t };
  }
  return { kind: 'restart', startS: Math.max(0, targetS) };
}

/** Fin de lecture prématurée (fichier perdu en route) : on reprend là où l'image s'est arrêtée. */
export const endedEarly = (positionS: number, durationS: number | null): boolean =>
  durationS !== null && positionS < durationS - END_EARLY_TOLERANCE_S;

/** Épisode suivant : le suivant de la saison, sinon le premier de la saison suivante. */
export function nextEpisode(
  seasons: readonly SeasonDto[],
  seasonId: string,
  episodes: readonly EpisodeDto[],
  episodeId: string,
): { seasonId: string; episodeId: string | null } | null {
  const index = episodes.findIndex((ep) => ep.id === episodeId);
  const next = index < 0 ? undefined : episodes[index + 1];
  if (next !== undefined) return { seasonId, episodeId: next.id };
  const ordered = [...seasons].sort((a, b) => a.number - b.number);
  const season = ordered[ordered.findIndex((s) => s.id === seasonId) + 1];
  // Premier épisode de la saison suivante : connu une fois ses épisodes chargés.
  return season === undefined || index < 0 ? null : { seasonId: season.id, episodeId: null };
}

/** « 1:02:03 » au-delà d'une heure, « 12:34 » sinon. */
export function formatClock(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / SECONDS_PER_HOUR);
  const m = Math.floor((s % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const sec = s % SECONDS_PER_MINUTE;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** Repère d'un épisode : « S2 · É5 — Titre ». */
export const episodeLabel = (season: number, episode: number, name: string): string =>
  `S${season} · É${episode}${name.trim() === '' ? '' : ` — ${name}`}`;

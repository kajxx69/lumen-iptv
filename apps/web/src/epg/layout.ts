import type { EpgEntryDto } from '@lumen/protocol';

const MINUTE_MS = 60_000;
/** Le guide s'aligne sur la demi-heure, comme une grille de magazine TV. */
export const GUIDE_STEP_MS = 30 * MINUTE_MS;
/** En deçà, un programme reste cliquable et lisible (au moins quelques lettres). */
const MIN_BLOCK_WIDTH_PX = 24;

export interface TimeWindow {
  start: number;
  end: number;
}

/** Fenêtre du guide : commence à la demi-heure en cours, dure `hours` heures. */
export function guideWindow(now: number, hours: number): TimeWindow {
  const start = Math.floor(now / GUIDE_STEP_MS) * GUIDE_STEP_MS;
  return { start, end: start + hours * 60 * MINUTE_MS };
}

export interface ProgrammeBlock {
  entry: EpgEntryDto;
  left: number;
  width: number;
  /** Programme en cours à l'instant `now`. */
  live: boolean;
}

/** Position des programmes d'une ligne du guide, coupés aux bords de la fenêtre. */
export function layoutProgrammes(
  entries: readonly EpgEntryDto[],
  window: TimeWindow,
  pxPerMinute: number,
  now: number,
): ProgrammeBlock[] {
  return [...entries]
    .filter((e) => e.end > window.start && e.start < window.end)
    .sort((a, b) => a.start - b.start)
    .map((entry) => {
      const from = Math.max(entry.start, window.start);
      const to = Math.min(entry.end, window.end);
      return {
        entry,
        left: ((from - window.start) / MINUTE_MS) * pxPerMinute,
        width: Math.max(MIN_BLOCK_WIDTH_PX, ((to - from) / MINUTE_MS) * pxPerMinute),
        live: entry.start <= now && now < entry.end,
      };
    });
}

export interface NowNext {
  now: EpgEntryDto | null;
  next: EpgEntryDto | null;
  /** Avancement du programme en cours, de 0 à 1. */
  progress: number;
}

export function nowNext(entries: readonly EpgEntryDto[], now: number): NowNext {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const current = sorted.find((e) => e.start <= now && now < e.end) ?? null;
  const next = sorted.find((e) => e.start >= (current?.end ?? now)) ?? null;
  const progress = current === null ? 0 : (now - current.start) / (current.end - current.start);
  return { now: current, next, progress: Math.min(1, Math.max(0, progress)) };
}

export const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

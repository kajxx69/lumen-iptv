/**
 * Déblocage de l'image au changement de source.
 *
 * Au changement de source (ou à la reconnexion), le relais marque une DISCONTINUITY : les
 * pistes audio et vidéo de la nouvelle source ne commencent pas exactement à la même
 * milliseconde que la fin de l'ancienne. Deux blocages s'ensuivent dans Chrome :
 * - un trou de quelques centaines de millisecondes entre deux plages du tampon ;
 * - une image immobile alors que des données la suivent (trou plus fin que ce que
 *   `buffered` laisse voir, sur l'une des deux pistes).
 * hls.js finit par s'en sortir, mais après 1 à 2 s d'image figée : on le fait nous-mêmes,
 * aussitôt, en sautant le trou ou en avançant d'un pas imperceptible.
 */

export interface BufferedRange {
  start: number;
  end: number;
}

export interface GapJumpOptions {
  /** Moins de données que cela devant la tête de lecture : elle bute sur la fin de la plage. */
  edgeS: number;
  /** Au-delà, sauter se verrait (perte de contenu) : on attend plutôt les données. */
  maxGapS: number;
  /** Atterrissage légèrement après le début de la plage, pour que le décodeur y trouve une image. */
  landingS: number;
  /** Pas en avant quand l'image est bloquée sur des données présentes (trois images à 30 i/s). */
  nudgeS: number;
}

export const GAP_JUMP: GapJumpOptions = { edgeS: 0.1, maxGapS: 2, landingS: 0.05, nudgeS: 0.1 };

/** Position où reprendre une lecture bloquée, ou null s'il n'y a qu'à attendre des données. */
export function stallEscapeTarget(
  ranges: readonly BufferedRange[],
  currentTime: number,
  options: GapJumpOptions = GAP_JUMP,
): number | null {
  for (const range of ranges) {
    if (range.start <= currentTime && currentTime < range.end - options.edgeS) {
      const nudged = currentTime + options.nudgeS;
      return nudged < range.end - options.edgeS ? nudged : null;
    }
  }
  const next = ranges.find((range) => range.start > currentTime);
  if (next === undefined || next.start - currentTime > options.maxGapS) return null;
  return next.start + options.landingS;
}

export const bufferedRanges = (buffered: TimeRanges): BufferedRange[] => {
  const ranges: BufferedRange[] = [];
  for (let i = 0; i < buffered.length; i++) ranges.push({ start: buffered.start(i), end: buffered.end(i) });
  return ranges;
};

/**
 * Navigation spatiale (télécommande D-pad, flèches du clavier) : depuis l'élément focalisé,
 * choisir le voisin le plus naturel dans une direction. Pur et géométrique : aucun écran
 * n'a à déclarer ses voisins à la main.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Poids du décalage latéral face à la distance dans l'axe : un voisin aligné mais un peu
 * plus loin l'emporte sur un voisin proche mais en biais, comme l'attend l'œil.
 */
const MISALIGNMENT_WEIGHT = 3;
/** Tolérance de chevauchement (px) : des bordures qui se touchent ne comptent pas comme « derrière ». */
const EDGE_TOLERANCE_PX = 1;

interface Axis {
  /** Distance dans la direction, bord à bord ; négative si le candidat n'est pas devant. */
  ahead: number;
  /** Décalage perpendiculaire ; 0 si les deux éléments se recouvrent sur cet axe. */
  offset: number;
}

function measure(from: Rect, to: Rect, dir: Direction): Axis {
  const horizontal = dir === 'left' || dir === 'right';
  const ahead =
    dir === 'right'
      ? to.left - (from.left + from.width)
      : dir === 'left'
        ? from.left - (to.left + to.width)
        : dir === 'down'
          ? to.top - (from.top + from.height)
          : from.top - (to.top + to.height);
  const [aStart, aEnd, bStart, bEnd] = horizontal
    ? [from.top, from.top + from.height, to.top, to.top + to.height]
    : [from.left, from.left + from.width, to.left, to.left + to.width];
  const offset = Math.max(0, bStart - aEnd, aStart - bEnd);
  return { ahead, offset };
}

/** Index du meilleur voisin dans `dir`, ou -1 s'il n'y en a aucun. */
export function pickNeighbor(from: Rect, candidates: readonly Rect[], dir: Direction): number {
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((rect, i) => {
    const { ahead, offset } = measure(from, rect, dir);
    if (ahead < -EDGE_TOLERANCE_PX) return;
    const score = Math.max(0, ahead) + MISALIGNMENT_WEIGHT * offset;
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export type NavAction = Direction | 'select' | 'back' | 'channelUp' | 'channelDown' | 'playPause';

/**
 * Touches des claviers, télécommandes de TV connectées et navigateurs de box : chacune
 * nomme le retour ou le changement de chaîne à sa façon.
 */
const KEY_ACTIONS: Record<string, NavAction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  Escape: 'back',
  Backspace: 'back',
  BrowserBack: 'back',
  GoBack: 'back',
  ChannelUp: 'channelUp',
  ChannelDown: 'channelDown',
  PageUp: 'channelUp',
  PageDown: 'channelDown',
  MediaPlayPause: 'playPause',
  ' ': 'playPause',
};

export const actionForKey = (key: string): NavAction | undefined => KEY_ACTIONS[key];

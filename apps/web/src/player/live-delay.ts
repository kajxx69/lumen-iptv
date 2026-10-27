/**
 * Retard volontaire sur le direct : c'est lui qui transforme le tampon du relais en
 * coupure invisible. Un lecteur collé au direct n'a que quelques secondes devant lui ; à
 * 20 s de retard, une coupure amont de 15 s passe inaperçue (PROJECT.md, suite de chaos).
 *
 * Le démarrage reste rapide (on joue dès le premier segment) ; le retard se construit
 * ensuite en lisant à 97 % de la vitesse, imperceptible à l'œil comme à l'oreille (le
 * navigateur conserve la hauteur du son). Le réglage fin du tampon arrive en phase 6.
 */

export interface LiveDelayOptions {
  /** Retard visé sur le direct. */
  targetS: number;
  /** Vitesse de lecture pendant la construction du retard. */
  slowRate: number;
  /** Écart toléré autour de la cible avant de changer de vitesse (évite les va-et-vient). */
  hysteresisS: number;
  /** Tampon minimal devant la tête de lecture pour se permettre de ralentir. */
  minBufferAheadS: number;
}

export const LIVE_DELAY: LiveDelayOptions = {
  targetS: 20,
  slowRate: 0.97,
  hysteresisS: 1,
  minBufferAheadS: 2,
};

export interface LiveDelayState {
  /** Retard actuel sur le direct (hls.js `latency`), null tant qu'il est inconnu. */
  latencyS: number | null;
  /** Secondes déjà téléchargées devant la tête de lecture. */
  bufferAheadS: number;
  /** Vitesse appliquée jusqu'ici. */
  currentRate: number;
}

export function liveRate(state: LiveDelayState, options: LiveDelayOptions = LIVE_DELAY): number {
  const { latencyS, bufferAheadS, currentRate } = state;
  if (latencyS === null || bufferAheadS < options.minBufferAheadS) return 1;
  const slowing = currentRate < 1;
  // Hystérésis : on ralentit sous (cible − marge), on revient à 1 une fois la cible atteinte.
  if (slowing) return latencyS < options.targetS ? options.slowRate : 1;
  return latencyS < options.targetS - options.hysteresisS ? options.slowRate : 1;
}

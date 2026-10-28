/**
 * Tampon client adaptatif (PROJECT.md, moteur de résilience §6).
 *
 * Démarrage court : on joue dès les premières secondes reçues (zapping rapide). Ensuite, le
 * retard visé sur le direct — c'est lui qui donne au spectateur de l'avance sur une panne —
 * part d'un plancher de 20 s, monte jusqu'à 60 s quand le réseau se montre instable
 * (coupure de lecture, segments lents à arriver) et redescend doucement quand il se calme.
 */

export interface AdaptiveBufferOptions {
  /** Plancher : couvre une coupure amont de 15 s (suite de chaos de PROJECT.md). */
  baseS: number;
  maxS: number;
  /** Chaque coupure de lecture ajoute ce retard visé. */
  stallStepS: number;
  /** Segments lents : arrivés en plus de cette part de leur durée, le réseau peine. */
  slowFragmentRatio: number;
  /** Part de segments lents (sur les derniers reçus) qui déclenche une hausse. */
  slowShare: number;
  slowStepS: number;
  /** Segments observés pour juger de la gigue. */
  fragmentWindow: number;
  /** Décroissance une fois le calme revenu (secondes de retard rendues par minute). */
  decayPerMinuteS: number;
}

export const ADAPTIVE_BUFFER: AdaptiveBufferOptions = {
  baseS: 20,
  maxS: 60,
  stallStepS: 10,
  slowFragmentRatio: 0.5,
  slowShare: 0.3,
  slowStepS: 5,
  fragmentWindow: 10,
  decayPerMinuteS: 2,
};

/**
 * « Direct au plus près » : le spectateur a choisi la latence. Plancher de 3 s (PROJECT.md :
 * 3–5 s), plafond de 8 s quand le réseau peine : au-delà, ce ne serait plus du direct.
 */
export const ADAPTIVE_BUFFER_LOW_LATENCY: AdaptiveBufferOptions = {
  ...ADAPTIVE_BUFFER,
  baseS: 3,
  maxS: 8,
  stallStepS: 2,
  slowStepS: 1,
};

const MINUTE_MS = 60_000;

export class AdaptiveBuffer {
  /** Surcroît de retard au-dessus du plancher, au moment `raisedAt`. */
  private extraS = 0;
  private raisedAt = 0;
  private ratios: number[] = [];
  private stallStart: number | null = null;
  private stalledMs = 0;

  constructor(private readonly options: AdaptiveBufferOptions = ADAPTIVE_BUFFER) {}

  private current(now: number): number {
    const decayed = this.extraS - ((now - this.raisedAt) / MINUTE_MS) * this.options.decayPerMinuteS;
    return Math.max(0, decayed);
  }

  private raise(now: number, stepS: number): void {
    const room = this.options.maxS - this.options.baseS;
    this.extraS = Math.min(room, this.current(now) + stepS);
    this.raisedAt = now;
  }

  /** Un segment est arrivé : `loadS` pour `durationS` secondes de flux. */
  fragmentLoaded(now: number, loadS: number, durationS: number): void {
    if (durationS <= 0) return;
    this.ratios.push(loadS / durationS);
    if (this.ratios.length > this.options.fragmentWindow) this.ratios.shift();
    const slow = this.ratios.filter((r) => r > this.options.slowFragmentRatio).length;
    if (
      this.ratios.length >= this.options.fragmentWindow / 2 &&
      slow / this.ratios.length >= this.options.slowShare
    ) {
      this.raise(now, this.options.slowStepS);
      // Jugement neuf pour la suite : une même rafale ne compte qu'une fois.
      this.ratios = [];
    }
  }

  /** La lecture s'est arrêtée faute de données. */
  stalled(now: number): void {
    this.raise(now, this.options.stallStepS);
    this.stallStart ??= now;
  }

  /** La lecture a repris. */
  resumed(now: number): void {
    if (this.stallStart !== null) this.stalledMs += now - this.stallStart;
    this.stallStart = null;
  }

  /** Temps passé à attendre depuis le dernier relevé (pour la métrique de rebuffering). */
  takeStalledMs(): number {
    const ms = this.stalledMs;
    this.stalledMs = 0;
    return ms;
  }

  /** Retard visé sur le direct, en secondes. */
  targetS(now: number): number {
    return Math.round(this.options.baseS + this.current(now));
  }
}

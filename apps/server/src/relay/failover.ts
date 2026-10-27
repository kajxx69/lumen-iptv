export interface FailoverOptions {
  /** Première attente une fois toutes les sources essayées (PROJECT.md : 200 ms). */
  initialDelayMs: number;
  /** Plafond de l'attente exponentielle (PROJECT.md : 10 s). */
  maxDelayMs: number;
  /**
   * Plafond tant que des spectateurs lisent encore leur tampon : chaque seconde gagnée
   * sur la reprise est une seconde de tampon conservée.
   */
  bufferedMaxDelayMs: number;
  /** Gigue relative (±) : des relais tombés ensemble ne réessaient pas tous au même instant. */
  jitterRatio: number;
}

export interface ConnectionOutcome {
  /** La connexion a publié au moins un segment avant de se terminer. */
  produced: boolean;
  /** Des segments récents restent à lire : le spectateur n'a pas encore vu la panne. */
  bufferedAhead: boolean;
  /** Bascule explicite (gel détecté, demande d'un test) plutôt qu'une panne réseau. */
  switchRequested?: boolean;
}

export interface FailoverDecision {
  source: number;
  delayMs: number;
  reason: 'reconnect' | 'switch' | 'backoff';
}

/**
 * Politique de bascule (PROJECT.md, moteur de résilience §5), au niveau réseau :
 *   1. nouveau create_link sur la même source (le lien a pu expirer) ;
 *   2. sinon, source suivante ;
 *   3. toutes en échec : attente exponentielle avec gigue, puis reprise sur l'origine.
 * L'ordre des sources sera remplacé par le score de santé (phase 5).
 */
export class FailoverPolicy {
  private current = 0;
  private retriedSame = false;
  private failedSources = 0;
  private round = 0;

  constructor(
    private readonly sourceCount: () => number,
    private readonly options: FailoverOptions,
    private readonly random: () => number = Math.random,
  ) {}

  get source(): number {
    return this.current;
  }

  next(outcome: ConnectionOutcome): FailoverDecision {
    const n = Math.max(1, this.sourceCount());
    if (outcome.produced) {
      this.retriedSame = false;
      this.failedSources = 0;
      this.round = 0;
    }
    if (outcome.switchRequested === true) {
      this.current = (this.current + 1) % n;
      this.retriedSame = false;
      return { source: this.current, delayMs: 0, reason: 'switch' };
    }
    // Au premier tour seulement : ensuite, chaque source n'a droit qu'à un essai par tour.
    if (!this.retriedSame && this.round === 0) {
      this.retriedSame = true;
      return { source: this.current, delayMs: 0, reason: 'reconnect' };
    }
    this.retriedSame = false;
    this.failedSources++;
    if (this.failedSources < n) {
      this.current = (this.current + 1) % n;
      return { source: this.current, delayMs: 0, reason: 'switch' };
    }
    this.failedSources = 0;
    this.current = 0;
    const cap = outcome.bufferedAhead ? this.options.bufferedMaxDelayMs : this.options.maxDelayMs;
    const nominal = Math.min(cap, this.options.initialDelayMs * 2 ** this.round);
    this.round++;
    const jitter = 1 + this.options.jitterRatio * (this.random() * 2 - 1);
    return { source: 0, delayMs: Math.round(nominal * jitter), reason: 'backoff' };
  }

  /** Toutes les sources ont échoué au moins une fois depuis la dernière production. */
  get exhausted(): boolean {
    return this.round > 0;
  }
}

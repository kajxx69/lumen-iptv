import type { Timers } from './runtime.js';

/**
 * Espace les requêtes d'au moins 1/débit seconde, dans l'ordre d'arrivée. Pas de rafale
 * autorisée : sur n'importe quelle fenêtre d'une seconde, le portail voit au plus
 * `ratePerSecond` requêtes, ce qui protège la MAC d'un bannissement.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlot = Number.NEGATIVE_INFINITY;

  constructor(
    ratePerSecond: number,
    private readonly timers: Timers,
  ) {
    if (!(ratePerSecond > 0)) throw new RangeError('le débit doit être strictement positif');
    this.intervalMs = 1000 / ratePerSecond;
  }

  acquire(): Promise<void> {
    const now = this.timers.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const wait = slot - now;
    return wait <= 0 ? Promise.resolve() : new Promise((resolve) => this.timers.setTimer(resolve, wait));
  }
}

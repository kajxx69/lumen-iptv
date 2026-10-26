import { describe, expect, it } from 'vitest';
import { RateLimiter, type Timers } from '../../stalker/index.js';

/** Horloge virtuelle : les minuteurs se déclenchent quand on avance le temps. */
class VirtualTimers implements Timers {
  time = 0;
  private timers: { at: number; callback: () => void }[] = [];

  now = (): number => this.time;

  setTimer = (callback: () => void, ms: number): (() => void) => {
    const timer = { at: this.time + ms, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  };

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await Promise.resolve();
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.callback();
      // Laisse les promesses réveillées s'exécuter avant le minuteur suivant.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    this.time = target;
  }
}

describe('RateLimiter', () => {
  it('espace les requêtes à 5 par seconde par défaut, même lancées en même temps', async () => {
    const timers = new VirtualTimers();
    const limiter = new RateLimiter(5, timers);
    const grantedAt: number[] = [];
    const all = Array.from({ length: 12 }, () => limiter.acquire().then(() => grantedAt.push(timers.now())));
    await timers.advance(5000);
    await Promise.all(all);
    expect(grantedAt).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200]);
  });

  it('ne dépasse jamais le débit sur une fenêtre glissante d une seconde', async () => {
    const timers = new VirtualTimers();
    const limiter = new RateLimiter(5, timers);
    const grantedAt: number[] = [];
    const waves = async (): Promise<void> => {
      for (let wave = 0; wave < 5; wave++) {
        await Promise.all(
          Array.from({ length: 4 }, () => limiter.acquire().then(() => grantedAt.push(timers.now()))),
        );
      }
    };
    const run = waves();
    await timers.advance(10_000);
    await run;
    for (const t of grantedAt)
      expect(grantedAt.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(5);
  });

  it('ne retarde pas une requête isolée après une période calme', async () => {
    const timers = new VirtualTimers();
    const limiter = new RateLimiter(5, timers);
    await limiter.acquire();
    await timers.advance(3000);
    const before = timers.now();
    const p = limiter.acquire();
    await timers.advance(0);
    await p;
    expect(timers.now()).toBe(before);
  });

  it('est configurable', async () => {
    const timers = new VirtualTimers();
    const limiter = new RateLimiter(2, timers);
    const grantedAt: number[] = [];
    const all = Array.from({ length: 3 }, () => limiter.acquire().then(() => grantedAt.push(timers.now())));
    await timers.advance(2000);
    await Promise.all(all);
    expect(grantedAt).toEqual([0, 500, 1000]);
  });

  it('refuse un débit nul ou négatif', () => {
    expect(() => new RateLimiter(0, new VirtualTimers())).toThrow(RangeError);
  });
});

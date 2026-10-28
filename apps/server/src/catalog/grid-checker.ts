import { GRID_MATCH, type GridProgramme, compareGrids, pairKey } from '@lumen/core/catalog';
import type { ChannelRef } from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { MergeStore } from '../store/merge-store.js';
import type { MergeService } from './merge-service.js';

const HOUR_MS = 3_600_000;

export interface GridCheckerOptions {
  /** Paires vérifiées par heure au plus : chacune coûte deux appels EPG au portail. */
  perHour: number;
  /** Fenêtre nocturne, comme le balayage des sondes : les portails sont peu sollicités. */
  startHour: number;
  endHour: number;
}

export interface GridCheckerDeps {
  merge: MergeService;
  store: MergeStore;
  /** Programmes d'une chaîne sur [from, to). */
  grid: (ref: ChannelRef, from: number, to: number) => Promise<GridProgramme[]>;
  /** Un spectateur regarde une chaîne de ce portail : beaucoup n'acceptent qu'une connexion. */
  portalBusy: (portalId: string) => boolean;
  log?: FastifyBaseLogger;
}

const inWindow = (now: number, start: number, end: number): boolean => {
  const hour = new Date(now).getHours();
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
};

/**
 * Confirmation des rapprochements par la grille de programmes (PROJECT.md : « la grille
 * EPG est le signal le plus fiable »). Le nom et l'identifiant EPG proposent ; la grille
 * de 6 h confirme ou refuse, la nuit, à débit limité.
 */
export class GridChecker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly options: GridCheckerOptions,
    private readonly deps: GridCheckerDeps,
  ) {}

  /** Vérifie la prochaine paire en attente ; « idle » s'il n'y a rien à faire maintenant. */
  async checkNext(now = Date.now()): Promise<'checked' | 'idle'> {
    if (!inWindow(now, this.options.startHour, this.options.endHour)) return 'idle';
    const { merge, store, portalBusy } = this.deps;
    const next = merge
      .pendingGridChecks(now)
      .find(([a, b]) => !portalBusy(a.portalId) && !portalBusy(b.portalId));
    if (next === undefined) return 'idle';
    const [a, b] = next;
    const to = now + GRID_MATCH.windowMs;
    let comparison: { similarity: number | null; verdict: 'same' | 'different' | null };
    try {
      const [ga, gb] = await Promise.all([this.deps.grid(a, now, to), this.deps.grid(b, now, to)]);
      comparison = compareGrids(ga, gb, now);
    } catch {
      // Grille indisponible : aucun avis ; la paire sera reprise à la prochaine échéance.
      comparison = { similarity: null, verdict: null };
    }
    store.setVerdict(pairKey(a, b), { ...comparison, checkedAt: now });
    if (comparison.verdict === 'different') {
      this.deps.log?.info(
        { similarity: comparison.similarity },
        'fusion : rapprochement refusé par la grille EPG',
      );
    }
    return 'checked';
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.checkNext()
        .catch((err: unknown) => {
          this.deps.log?.warn(
            { err: err instanceof Error ? err.message : 'inconnue' },
            'vérification de grille en échec',
          );
        })
        .finally(() => {
          this.running = false;
        });
    }, HOUR_MS / this.options.perHour);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

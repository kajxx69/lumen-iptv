import type { SourceRef } from './health-service.js';

export interface ProbeOptions {
  /** Chaque favori est sondé à ce rythme (PROJECT.md : toutes les 15 minutes). */
  favoritesIntervalMs: number;
  /** Fenêtre du balayage complet du catalogue, en heures locales [début, fin). */
  catalogStartHour: number;
  catalogEndHour: number;
  /** Rythme du balayage : le portail ne doit jamais y voir un abus. */
  catalogProbesPerHour: number;
}

export interface ProbeSources {
  favorites(): SourceRef[];
  /** Toutes les chaînes connues ; lu une fois par balayage. */
  catalog(): SourceRef[];
  /** Une chaîne de ce portail est en cours de lecture : ne pas lui prendre sa connexion. */
  portalBusy(portalId: string): boolean;
}

const HOUR_MS = 3_600_000;
const keyOf = (r: SourceRef): string => `${r.portalId}\u0000${r.channelId}`;
/** Nuit à laquelle appartient un instant : les heures avant midi comptent pour la veille. */
const nightOf = (now: number): string => new Date(now - 12 * HOUR_MS).toDateString();

/**
 * Quelle chaîne sonder maintenant (PROJECT.md, moteur de résilience §4) : connaître l'état
 * d'une chaîne avant que l'utilisateur ne clique dessus. Favoris d'abord, à intervalle
 * régulier ; le catalogue complet la nuit, à débit limité, en reprenant où il s'est arrêté.
 * Jamais sur un portail occupé : beaucoup n'acceptent qu'une connexion par MAC.
 */
export class ProbeScheduler {
  private readonly lastProbed = new Map<string, number>();
  private catalogList: SourceRef[] | null = null;
  private cursor = 0;
  private lastCatalogProbeAt = -Infinity;
  private finishedNight: string | null = null;

  constructor(
    private readonly options: ProbeOptions,
    private readonly sources: ProbeSources,
  ) {}

  next(now: number): SourceRef | null {
    for (const fav of this.sources.favorites()) {
      if (this.sources.portalBusy(fav.portalId)) continue;
      const last = this.lastProbed.get(keyOf(fav));
      if (last === undefined || now - last >= this.options.favoritesIntervalMs) return fav;
    }
    const hour = new Date(now).getHours();
    if (hour < this.options.catalogStartHour || hour >= this.options.catalogEndHour) return null;
    if (this.finishedNight === nightOf(now)) return null;
    if (now - this.lastCatalogProbeAt < HOUR_MS / this.options.catalogProbesPerHour) return null;
    this.catalogList ??= this.sources.catalog();
    const candidate = this.catalogList[this.cursor];
    if (candidate === undefined) {
      // Balayage terminé : le prochain repart du début, la nuit suivante.
      this.finishedNight = nightOf(now);
      this.cursor = 0;
      this.catalogList = null;
      return null;
    }
    // Portail occupé : on attend qu'il se libère plutôt que de sauter ses chaînes.
    return this.sources.portalBusy(candidate.portalId) ? null : candidate;
  }

  done(ref: SourceRef, now: number): void {
    this.lastProbed.set(keyOf(ref), now);
    const current = this.catalogList?.[this.cursor];
    if (current !== undefined && keyOf(current) === keyOf(ref)) {
      this.cursor++;
      this.lastCatalogProbeAt = now;
    }
  }
}

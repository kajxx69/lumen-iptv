import type { UpstreamLink } from '../relay/upstream.js';

/** Liens gardés au plus : les voisines de chaque spectateur, pas un annuaire du portail. */
const MAX_PREFETCHED_LINKS = 200;

/**
 * Zapping instantané (PROJECT.md) : les liens des chaînes voisines de celle regardée sont
 * demandés au portail à l'avance (create_link), pendant que le spectateur regarde. Au zapping,
 * le relais part aussitôt, sans l'aller-retour au portail. Un lien ne sert qu'une fois (certains
 * portails n'en acceptent pas plus) et vieillit vite (jeton) : au-delà de `ttlMs`, oublié.
 */
export class LinkPrefetcher {
  private readonly links = new Map<string, { link: UpstreamLink; at: number }>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Demande le lien s'il n'est pas déjà frais ou en cours ; un échec est sans conséquence. */
  async prefetch(key: string, resolve: () => Promise<UpstreamLink>): Promise<void> {
    if (this.fresh(key) || this.pending.has(key)) return;
    this.pending.add(key);
    try {
      const link = await resolve();
      this.links.delete(key);
      this.links.set(key, { link, at: this.now() });
      for (const old of this.links.keys()) {
        if (this.links.size <= MAX_PREFETCHED_LINKS) break;
        this.links.delete(old);
      }
    } catch {
      // Le portail a refusé ou n'a pas répondu : le zapping demandera le lien lui-même.
    } finally {
      this.pending.delete(key);
    }
  }

  /** Lien frais pour cette chaîne, retiré du cache (usage unique) ; null sinon. */
  take(key: string): UpstreamLink | null {
    const hit = this.links.get(key);
    this.links.delete(key);
    return hit !== undefined && this.now() - hit.at <= this.ttlMs ? hit.link : null;
  }

  private fresh(key: string): boolean {
    const hit = this.links.get(key);
    return hit !== undefined && this.now() - hit.at <= this.ttlMs;
  }
}

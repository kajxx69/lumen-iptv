/**
 * Compteur à fenêtre fixe par clé (utilisateur, ou adresse + identifiant). Suffisant pour un
 * serveur auto-hébergé à une instance ; un déploiement multi-instance demanderait un état partagé.
 */
export class FixedWindowCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private current(key: string, now: number): { start: number; count: number } {
    const w = this.windows.get(key);
    if (w !== undefined && now - w.start < this.windowMs) return w;
    const fresh = { start: now, count: 0 };
    this.windows.set(key, fresh);
    return fresh;
  }

  /** Compte une occurrence ; renvoie false si la limite est déjà atteinte. */
  hit(key: string, now: number): boolean {
    const w = this.current(key, now);
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  /** Vrai si la clé a atteint sa limite, sans compter d'occurrence. */
  exhausted(key: string, now: number): boolean {
    return this.current(key, now).count >= this.limit;
  }

  /** Libère la mémoire des fenêtres expirées. */
  sweep(now: number): void {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}

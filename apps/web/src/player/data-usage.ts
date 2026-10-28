/**
 * Consommation de données de cet appareil, par mois (PROJECT.md : compteur visible). Gardée
 * dans le stockage local ; s'il est refusé, le compteur vit en mémoire le temps de la page.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'lumen.dataUsage';

interface Stored {
  month: string;
  bytes: number;
}

const monthOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export class DataUsage {
  private memory: Stored | null = null;

  constructor(private readonly store: KeyValueStore) {}

  private read(): Stored | null {
    try {
      const raw = this.store.getItem(KEY);
      if (raw === null) return this.memory;
      const parsed = JSON.parse(raw) as Partial<Stored>;
      return typeof parsed.month === 'string' && typeof parsed.bytes === 'number'
        ? { month: parsed.month, bytes: parsed.bytes }
        : this.memory;
    } catch {
      return this.memory;
    }
  }

  private write(value: Stored): void {
    this.memory = value;
    try {
      this.store.setItem(KEY, JSON.stringify(value));
    } catch {
      // Stockage refusé : la mémoire suffit le temps de la page.
    }
  }

  /** Octets consommés ce mois-ci. */
  bytes(now: Date = new Date()): number {
    const stored = this.read();
    return stored?.month === monthOf(now) ? stored.bytes : 0;
  }

  add(bytes: number, now: Date = new Date()): void {
    if (bytes <= 0) return;
    this.write({ month: monthOf(now), bytes: this.bytes(now) + bytes });
  }

  reset(now: Date = new Date()): void {
    this.write({ month: monthOf(now), bytes: 0 });
  }
}

/** Compteur de l'appareil (navigateur). */
export const dataUsage = new DataUsage({
  getItem: (k) => window.localStorage.getItem(k),
  setItem: (k, v) => {
    window.localStorage.setItem(k, v);
  },
});

/** « 1,2 Go », « 350 Mo » : unités décimales, comme les forfaits mobiles. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
  return `${Math.round(bytes / 1e6).toLocaleString('fr-FR')} Mo`;
}

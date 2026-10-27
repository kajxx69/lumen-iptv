/**
 * Score de santé par couple (chaîne, source) — PROJECT.md, moteur de résilience §3.
 * Pur : les événements arrivent horodatés, le temps est passé en argument. Le serveur les
 * alimente (relais, sondes) et persiste l'état en SQLite pour qu'il survive au redémarrage.
 */

export interface SourceHealth {
  /** Temps moyen de create_link (ms). */
  resolveLatencyMs: number;
  /** Temps moyen jusqu'au premier octet du flux (ms). */
  timeToFirstByteMs: number;
  /** Part des segments (et liens) en échec, fenêtre glissante de 5 min. */
  segmentFailureRate: number;
  /** Coefficient de variation du débit des segments, 5 min. */
  bitrateJitter: number;
  /** Gels (PTS figés) sur la dernière heure. */
  freezeEventsPerHour: number;
  /** Pannes de contenu (image noire, silence) sur la dernière heure. */
  contentEventsPerHour: number;
  /** Part du temps disponible sur 24 h, de 0 à 1. */
  uptime24h: number;
  /** Mesures disponibles : 0 = source jamais essayée. */
  samples: number;
  /** De 0 à 100, pondéré : plus haut est meilleur. */
  score: number;
}

export type HealthEvent =
  | { kind: 'resolve'; at: number; ms: number; ok: boolean }
  | { kind: 'firstByte'; at: number; ms: number }
  | { kind: 'segment'; at: number; ok: boolean; bitrateKbps?: number }
  | { kind: 'freeze'; at: number }
  | { kind: 'content'; at: number }
  | { kind: 'up'; at: number }
  | { kind: 'down'; at: number };

export interface HealthOptions {
  /** Événements conservés au plus par source : mémoire et taille SQLite bornées. */
  maxEvents: number;
  /** Mesures de latence moyennées. */
  latencySamples: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = { maxEvents: 600, latencySamples: 10 };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FAILURE_WINDOW_MS = 5 * MINUTE_MS;
const JITTER_WINDOW_MS = 5 * MINUTE_MS;
const INCIDENT_WINDOW_MS = HOUR_MS;

/**
 * Pondération du score. Une panne de contenu (image noire) pèse le plus : le spectateur la
 * voit en entier ; un lien lent ne retarde que le démarrage.
 */
const WEIGHTS = {
  /** Latences : sans pénalité jusqu'à 500 ms, pénalité pleine à 5 s. */
  latencyFreeMs: 500,
  latencyFullMs: 5000,
  resolveMax: 15,
  firstByteMax: 15,
  /** Points perdus pour 100 % d'échecs. */
  failureMax: 25,
  /** Gigue tolérée (variations normales d'un encodage VBR), pénalité pleine à 100 %. */
  jitterFree: 0.1,
  jitterFull: 1,
  jitterMax: 10,
  perFreeze: 15,
  freezeMax: 30,
  perContent: 20,
  contentMax: 40,
  /** Points perdus pour 100 % d'indisponibilité sur 24 h. */
  uptimeMax: 30,
  /**
   * Source jamais essayée : prudence. Elle passe derrière une source connue et saine,
   * mais devant une source qui vient de montrer un écran noir.
   */
  unknown: 15,
} as const;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const ramp = (value: number, free: number, full: number): number => clamp01((value - free) / (full - free));

export function scoreHealth(h: Omit<SourceHealth, 'score'>): number {
  const w = WEIGHTS;
  const penalty =
    w.resolveMax * ramp(h.resolveLatencyMs, w.latencyFreeMs, w.latencyFullMs) +
    w.firstByteMax * ramp(h.timeToFirstByteMs, w.latencyFreeMs, w.latencyFullMs) +
    w.failureMax * clamp01(h.segmentFailureRate) +
    w.jitterMax * ramp(h.bitrateJitter, w.jitterFree, w.jitterFull) +
    Math.min(w.freezeMax, w.perFreeze * h.freezeEventsPerHour) +
    Math.min(w.contentMax, w.perContent * h.contentEventsPerHour) +
    w.uptimeMax * (1 - clamp01(h.uptime24h)) +
    (h.samples === 0 ? w.unknown : 0);
  return Math.max(0, Math.round(100 - penalty));
}

export interface SerializedHealth {
  events: HealthEvent[];
}

const KINDS = new Set(['resolve', 'firstByte', 'segment', 'freeze', 'content', 'up', 'down']);

function isEvent(value: unknown): value is HealthEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; at?: unknown };
  return typeof v.kind === 'string' && KINDS.has(v.kind) && typeof v.at === 'number';
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export class HealthTracker {
  private events: HealthEvent[] = [];

  constructor(private readonly options: HealthOptions = DEFAULT_HEALTH_OPTIONS) {}

  static fromJSON(data: unknown, options: HealthOptions = DEFAULT_HEALTH_OPTIONS): HealthTracker {
    const tracker = new HealthTracker(options);
    const events = (data as { events?: unknown } | null)?.events;
    // Données corrompues ou d'une version antérieure : on repart de zéro, sans erreur.
    if (Array.isArray(events)) tracker.events = events.filter(isEvent).slice(-options.maxEvents);
    return tracker;
  }

  toJSON(): SerializedHealth {
    return { events: [...this.events] };
  }

  record(event: HealthEvent): void {
    this.events.push(event);
    const horizon = event.at - DAY_MS;
    if (this.events.length > this.options.maxEvents || (this.events[0]?.at ?? event.at) < horizon) {
      this.events = this.events.filter((e) => e.at >= horizon).slice(-this.options.maxEvents);
    }
  }

  health(now: number): SourceHealth {
    const lastOf = (kind: 'resolve' | 'firstByte'): number[] =>
      this.events
        .filter((e): e is Extract<HealthEvent, { kind: typeof kind }> => e.kind === kind)
        .slice(-this.options.latencySamples)
        .map((e) => e.ms);
    const attempts = this.events.filter(
      (e): e is Extract<HealthEvent, { kind: 'segment' | 'resolve' }> =>
        (e.kind === 'segment' || e.kind === 'resolve') && e.at >= now - FAILURE_WINDOW_MS,
    );
    const bitrates = this.events
      .filter((e) => e.kind === 'segment' && e.at >= now - JITTER_WINDOW_MS)
      .map((e) => (e.kind === 'segment' ? (e.bitrateKbps ?? 0) : 0))
      .filter((k) => k > 0);
    const avg = mean(bitrates);
    const jitter =
      bitrates.length < 2 || avg === 0 ? 0 : Math.sqrt(mean(bitrates.map((b) => (b - avg) ** 2))) / avg;
    const recent = (kind: 'freeze' | 'content'): number =>
      this.events.filter((e) => e.kind === kind && e.at >= now - INCIDENT_WINDOW_MS && e.at <= now).length;
    const base = {
      resolveLatencyMs: Math.round(mean(lastOf('resolve'))),
      timeToFirstByteMs: Math.round(mean(lastOf('firstByte'))),
      segmentFailureRate: attempts.length === 0 ? 0 : attempts.filter((e) => !e.ok).length / attempts.length,
      bitrateJitter: jitter,
      freezeEventsPerHour: recent('freeze'),
      contentEventsPerHour: recent('content'),
      uptime24h: this.uptime(now),
      samples: this.events.filter(
        (e) => e.kind === 'resolve' || e.kind === 'firstByte' || e.kind === 'segment',
      ).length,
    };
    return { ...base, score: scoreHealth(base) };
  }

  /** Part du temps « disponible » depuis 24 h (ou depuis la première mesure, si plus récente). */
  private uptime(now: number): number {
    const changes = this.events.filter((e) => e.kind === 'up' || e.kind === 'down');
    const first = changes[0];
    if (first === undefined) return 1;
    const start = Math.max(now - DAY_MS, first.at);
    if (now <= start) return 1;
    let down = false;
    let since = start;
    let downtime = 0;
    for (const e of changes) {
      if (e.at <= start) {
        down = e.kind === 'down';
        continue;
      }
      if (e.at > now) break;
      if (down) downtime += e.at - since;
      down = e.kind === 'down';
      since = e.at;
    }
    if (down) downtime += now - since;
    return 1 - downtime / (now - start);
  }
}

/** Sources classées par score décroissant ; à égalité, l'ordre d'origine (celle demandée d'abord). */
export function rankSources<T extends { score: number }>(sources: readonly T[]): T[] {
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map(({ s }) => s);
}

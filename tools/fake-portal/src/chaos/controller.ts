import type { Clock } from '../clock.js';
import { type Rng, hashSeed, mulberry32 } from '../random.js';

export type LatencyScope = 'api' | 'stream';
export type HttpErrorScope = LatencyScope | 'all';

/** Fenêtre de panne en temps mural ; channelId null = toutes les chaînes. */
export interface ChaosWindow {
  startMs: number;
  endMs: number;
  channelId: string | null;
}

export interface HttpErrorRule {
  code: number;
  probability: number;
  scope: HttpErrorScope;
}

export interface ChaosSnapshot {
  latencyMs: Record<LatencyScope, number>;
  httpError: HttpErrorRule | null;
  throttleKbps: number | null;
  corruptSegmentProbability: number;
  drops: ChaosWindow[];
  freezes: ChaosWindow[];
  blackscreens: ChaosWindow[];
  tokenGeneration: number;
}

export interface ChaosListeners {
  /** Une coupure commence : les connexions de flux concernées doivent être fermées. */
  onDrop(window: ChaosWindow): void;
  /** Tous les tokens sont invalidés ; killStreams ferme aussi les flux en cours. */
  onExpireTokens(killStreams: boolean): void;
}

// Graine par défaut : les tirages sont reproductibles d'un lancement à l'autre.
const DEFAULT_CHAOS_SEED = 0xc4a05;

/**
 * État des pannes injectées. Les pannes temporelles sont des fenêtres sur l'horloge
 * murale, évaluées au moment où chaque octet est produit : une panne déclenchée en
 * cours de lecture affecte immédiatement le flux.
 */
export class ChaosController {
  private latencyMs: Record<LatencyScope, number> = { api: 0, stream: 0 };
  private httpError: HttpErrorRule | null = null;
  private httpRng: Rng = mulberry32(DEFAULT_CHAOS_SEED);
  private throttle: number | null = null;
  private corruptProbability = 0;
  private corruptSeed = DEFAULT_CHAOS_SEED;
  private drops: ChaosWindow[] = [];
  private freezes: ChaosWindow[] = [];
  private blackscreens: ChaosWindow[] = [];
  private tokenGeneration = 0;
  private readonly listeners: ChaosListeners[] = [];

  constructor(private readonly clock: Clock) {}

  subscribe(listener: ChaosListeners): void {
    this.listeners.push(listener);
  }

  setLatency(ms: number, scope: LatencyScope): void {
    this.latencyMs[scope] = ms;
  }

  latencyFor(scope: LatencyScope): number {
    return this.latencyMs[scope];
  }

  drop(durationMs: number, channelId: string | null): ChaosWindow {
    const window = this.window(durationMs, channelId);
    this.drops.push(window);
    for (const l of this.listeners) l.onDrop(window);
    return window;
  }

  isDropped(channelId: string, atMs = this.clock.now()): boolean {
    return this.drops.some((w) => covers(w, channelId, atMs));
  }

  expireTokens(killStreams: boolean): void {
    this.tokenGeneration++;
    for (const l of this.listeners) l.onExpireTokens(killStreams);
  }

  setHttpError(rule: HttpErrorRule, seed?: number): void {
    this.httpError = rule;
    this.httpRng = mulberry32(seed ?? DEFAULT_CHAOS_SEED);
  }

  /** Code HTTP à renvoyer à la place de la réponse normale, ou null. */
  injectedHttpError(scope: LatencyScope): number | null {
    const rule = this.httpError;
    if (rule === null || (rule.scope !== 'all' && rule.scope !== scope)) return null;
    return this.httpRng() < rule.probability ? rule.code : null;
  }

  setThrottle(bitrateKbps: number): void {
    this.throttle = bitrateKbps;
  }

  get throttleKbps(): number | null {
    return this.throttle;
  }

  setCorrupt(segmentProbability: number, seed?: number): void {
    this.corruptProbability = segmentProbability;
    this.corruptSeed = seed ?? DEFAULT_CHAOS_SEED;
  }

  /** Tirage déterministe par (chaîne, segment) : un segment re-téléchargé reste identique. */
  isSegmentCorrupted(channelId: string, segmentIndex: number): boolean {
    if (this.corruptProbability <= 0) return false;
    return mulberry32(hashSeed(this.corruptSeed, channelId, segmentIndex))() < this.corruptProbability;
  }

  get corruptionSeed(): number {
    return this.corruptSeed;
  }

  freeze(durationMs: number, channelId: string | null): ChaosWindow {
    const window = this.window(durationMs, channelId);
    this.freezes.push(window);
    return window;
  }

  freezeAt(channelId: string, atMs: number): ChaosWindow | null {
    return this.freezes.find((w) => covers(w, channelId, atMs)) ?? null;
  }

  blackscreen(durationMs: number, channelId: string | null): ChaosWindow {
    const window = this.window(durationMs, channelId);
    this.blackscreens.push(window);
    return window;
  }

  isBlackAt(channelId: string, atMs: number): boolean {
    return this.blackscreens.some((w) => covers(w, channelId, atMs));
  }

  reset(): void {
    this.latencyMs = { api: 0, stream: 0 };
    this.httpError = null;
    this.httpRng = mulberry32(DEFAULT_CHAOS_SEED);
    this.throttle = null;
    this.corruptProbability = 0;
    this.corruptSeed = DEFAULT_CHAOS_SEED;
    this.drops = [];
    this.freezes = [];
    this.blackscreens = [];
  }

  snapshot(): ChaosSnapshot {
    const now = this.clock.now();
    const live = (ws: ChaosWindow[]): ChaosWindow[] => ws.filter((w) => w.endMs > now);
    return {
      latencyMs: { ...this.latencyMs },
      httpError: this.httpError,
      throttleKbps: this.throttle,
      corruptSegmentProbability: this.corruptProbability,
      drops: live(this.drops),
      freezes: live(this.freezes),
      blackscreens: live(this.blackscreens),
      tokenGeneration: this.tokenGeneration,
    };
  }

  private window(durationMs: number, channelId: string | null): ChaosWindow {
    const startMs = this.clock.now();
    const alive = (w: ChaosWindow): boolean => w.endMs > startMs;
    this.drops = this.drops.filter(alive);
    this.freezes = this.freezes.filter(alive);
    this.blackscreens = this.blackscreens.filter(alive);
    return { startMs, endMs: startMs + durationMs, channelId };
  }
}

function covers(w: ChaosWindow, channelId: string, atMs: number): boolean {
  return atMs >= w.startMs && atMs < w.endMs && (w.channelId === null || w.channelId === channelId);
}

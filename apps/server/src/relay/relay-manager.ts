import type { FastifyBaseLogger } from 'fastify';
import type { MetricsRegistry } from '../metrics/registry.js';
import { Relay, type RelayDeps, type RelayOptions, type RelaySource } from './relay.js';
import { RelayMetrics } from './relay-metrics.js';
import { SegmentCache } from './segment-cache.js';

export interface RelayManagerOptions {
  relay: RelayOptions;
  /**
   * Délai de grâce après le départ du dernier spectateur : un retour rapide (zapping
   * aller-retour, rechargement de page) retrouve le tampon plein, sans reconnexion.
   */
  lingerMs: number;
  segmentCacheBytes: number;
  /** Événements de santé des sources, pour le score (moteur de résilience). */
  health?: RelayDeps['health'];
  /** Analyse d'image et de son (écran noir, silence). */
  content?: RelayDeps['content'];
}

/**
 * Un relais par chaîne, partagé par tous ses spectateurs : une seule connexion amont par
 * chaîne, quel que soit le nombre de lecteurs (les portails limitent les connexions par MAC).
 */
export class RelayManager {
  private readonly relays = new Map<string, Relay>();
  private readonly lingerTimers = new Map<Relay, NodeJS.Timeout>();
  private readonly cache: SegmentCache;
  readonly metrics: RelayMetrics;

  constructor(
    private readonly options: RelayManagerOptions,
    registry: MetricsRegistry,
    private readonly log: FastifyBaseLogger,
  ) {
    this.cache = new SegmentCache(options.segmentCacheBytes);
    this.metrics = new RelayMetrics(registry, {
      relays: () => this.relays.size,
      viewers: () => [...this.relays.values()].reduce((n, r) => n + r.viewers, 0),
      bufferedBytes: () => [...this.relays.values()].reduce((n, r) => n + r.bufferedBytes, 0),
      cachedBytes: () => this.cache.bytes,
    });
  }

  /** Rattache un spectateur au relais de la chaîne, en l'ouvrant si besoin. */
  acquire(key: string, sources: readonly RelaySource[]): Relay {
    let relay = this.relays.get(key);
    if (relay === undefined) {
      // Un relais sans spectateur occupe une connexion sur la MAC du portail : il cède la
      // place à la chaîne demandée plutôt que de la faire refuser.
      this.closeIdle(new Set(sources.map((s) => s.portalId)));
      relay = new Relay(key, sources, this.options.relay, {
        cache: this.cache,
        metrics: this.metrics,
        log: this.log,
        ...(this.options.health === undefined ? {} : { health: this.options.health }),
        ...(this.options.content === undefined ? {} : { content: this.options.content }),
      });
      this.relays.set(key, relay);
      relay.start();
    } else {
      relay.addSources(sources);
    }
    const timer = this.lingerTimers.get(relay);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.lingerTimers.delete(relay);
    }
    relay.viewers++;
    relay.idleSince = null;
    return relay;
  }

  /** Détache un spectateur ; `immediate` ferme sans délai de grâce (démarrage en échec). */
  release(relay: Relay, immediate = false): void {
    relay.viewers = Math.max(0, relay.viewers - 1);
    if (relay.viewers > 0) return;
    relay.idleSince = Date.now();
    if (immediate) {
      this.closeRelay(relay, 'démarrage en échec');
      return;
    }
    if (this.lingerTimers.has(relay)) return;
    const timer = setTimeout(() => {
      this.closeRelay(relay, 'plus de spectateur');
    }, this.options.lingerMs);
    timer.unref();
    this.lingerTimers.set(relay, timer);
  }

  get size(): number {
    return this.relays.size;
  }

  /** Un relais (même sans spectateur, pendant son délai de grâce) tient une connexion sur ce portail. */
  portalBusy(portalId: string): boolean {
    for (const relay of this.relays.values()) if (relay.status.activePortalId === portalId) return true;
    return false;
  }

  closeAll(): void {
    for (const relay of [...this.relays.values()]) this.closeRelay(relay, 'arrêt du serveur');
  }

  private closeIdle(portalIds: ReadonlySet<string>): void {
    for (const relay of [...this.relays.values()]) {
      if (relay.viewers > 0) continue;
      if (relay.portalIds.some((id) => portalIds.has(id)))
        this.closeRelay(relay, 'place cédée à une autre chaîne');
    }
  }

  private closeRelay(relay: Relay, reason: string): void {
    const timer = this.lingerTimers.get(relay);
    if (timer !== undefined) clearTimeout(timer);
    this.lingerTimers.delete(relay);
    if (this.relays.get(relay.key) === relay) this.relays.delete(relay.key);
    relay.close(reason);
  }
}

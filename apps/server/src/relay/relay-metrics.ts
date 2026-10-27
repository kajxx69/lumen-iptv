import type { Counter, Histogram, MetricsRegistry } from '../metrics/registry.js';

/** Bornes du temps de démarrage : la cible est < 2 s au 95e centile (PROJECT.md). */
const STARTUP_BUCKETS_S = [0.25, 0.5, 1, 1.5, 2, 3, 5, 10];
/** Bornes de durée de bascule : la cible est < 2 s. */
const SWITCH_BUCKETS_S = [0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 30];

export interface RelayGaugeSources {
  relays: () => number;
  viewers: () => number;
  bufferedBytes: () => number;
  cachedBytes: () => number;
}

/** Métriques du relais. Aucune étiquette n'identifie un portail, une chaîne ou un utilisateur. */
export class RelayMetrics {
  activeUpstreams = 0;
  readonly startupSeconds: Histogram;
  readonly recoverySeconds: Histogram;
  readonly switches: Counter;
  readonly upstreamFailures: Counter;
  readonly resolveFailures: Counter;
  readonly segments: Counter;
  readonly forcedCuts: Counter;
  readonly skippedSegments: Counter;
  readonly bytesIn: Counter;
  readonly bytesOut: Counter;
  /** Ratio de rebuffering = attente / (lecture + attente), mesuré par les lecteurs. */
  readonly watchSeconds: Counter;
  readonly stallSeconds: Counter;

  constructor(registry: MetricsRegistry, gauges: RelayGaugeSources) {
    registry.gauge(
      'lumen_relay_upstream_connections',
      'Connexions amont ouvertes',
      () => this.activeUpstreams,
    );
    registry.gauge('lumen_relay_active', 'Relais actifs (une chaîne, une connexion amont)', gauges.relays);
    registry.gauge('lumen_relay_viewers', 'Spectateurs rattachés à un relais', gauges.viewers);
    registry.gauge('lumen_relay_buffered_bytes', 'Octets dans les tampons glissants', gauges.bufferedBytes);
    registry.gauge(
      'lumen_relay_cache_bytes',
      'Octets dans le cache des segments évincés',
      gauges.cachedBytes,
    );
    this.startupSeconds = registry.histogram(
      'lumen_relay_startup_seconds',
      'Ouverture d’un relais jusqu’au premier segment publié',
      STARTUP_BUCKETS_S,
    );
    this.recoverySeconds = registry.histogram(
      'lumen_relay_recovery_seconds',
      'Panne amont jusqu’au premier segment publié après reprise ou bascule',
      SWITCH_BUCKETS_S,
    );
    this.switches = registry.counter('lumen_relay_source_switches_total', 'Bascules vers une autre source');
    this.upstreamFailures = registry.counter(
      'lumen_relay_upstream_failures_total',
      'Connexions amont terminées en panne',
    );
    this.resolveFailures = registry.counter('lumen_link_resolution_failures_total', 'Échecs de create_link');
    this.segments = registry.counter('lumen_relay_segments_total', 'Segments publiés');
    this.forcedCuts = registry.counter('lumen_relay_forced_cuts_total', 'Segments coupés sans image clé');
    this.skippedSegments = registry.counter('lumen_relay_skipped_segments_total', 'Segments amont sautés');
    this.bytesIn = registry.counter('lumen_relay_bytes_in_total', 'Octets reçus de l’amont');
    this.bytesOut = registry.counter('lumen_relay_bytes_out_total', 'Octets servis aux spectateurs');
    this.watchSeconds = registry.counter(
      'lumen_playback_watch_seconds_total',
      'Temps de lecture vu par les lecteurs (s)',
    );
    this.stallSeconds = registry.counter(
      'lumen_playback_stall_seconds_total',
      'Temps passé à attendre des données (s)',
    );
  }
}

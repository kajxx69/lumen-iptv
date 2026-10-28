// Moteur de résilience : score de santé des sources (phase 5).
export {
  DEFAULT_HEALTH_OPTIONS,
  type HealthEvent,
  type HealthOptions,
  HealthTracker,
  type SerializedHealth,
  type SourceHealth,
  diversifyHosts,
  rankSources,
  scoreHealth,
} from './health.js';

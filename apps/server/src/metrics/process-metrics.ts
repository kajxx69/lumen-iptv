import type { MetricsRegistry } from './registry.js';

const MICROSECONDS_PER_SECOND = 1_000_000;

/**
 * Métriques du processus, aux noms standard de Prometheus : temps CPU (utilisateur +
 * système) et mémoire résidente. Le CPU sert aussi de futur repère du coût du transcodage.
 */
export function registerProcessMetrics(registry: MetricsRegistry): void {
  registry.counterFrom('process_cpu_seconds_total', 'Temps CPU consommé par le serveur (s)', () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / MICROSECONDS_PER_SECOND;
  });
  registry.gauge(
    'process_resident_memory_bytes',
    'Mémoire résidente du serveur',
    () => process.memoryUsage().rss,
  );
  registry.gauge('process_start_time_seconds', 'Démarrage du serveur (s depuis 1970)', () =>
    Math.round((Date.now() - process.uptime() * 1000) / 1000),
  );
}

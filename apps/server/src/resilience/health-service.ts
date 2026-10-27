import { type HealthEvent, HealthTracker, type SourceHealth } from '@lumen/core/resilience';
import type { Db } from '../store/database.js';

/** Une source : une chaîne sur un portail. */
export interface SourceRef {
  portalId: string;
  channelId: string;
}

/**
 * Les scores changent à chaque segment ; ils sont écrits en SQLite par lots : au plus
 * une écriture par source toutes les 30 s, et à l'arrêt du serveur.
 */
const FLUSH_INTERVAL_MS = 30_000;

const keyOf = (ref: SourceRef): string => `${ref.portalId}\u0000${ref.channelId}`;

/**
 * Santé de chaque source, alimentée par le relais (liens, segments, gels, pannes de
 * contenu) et par les sondes de fond. Sert à classer les sources : jamais l'ordre de la liste.
 */
export class HealthService {
  private readonly trackers = new Map<string, { ref: SourceRef; tracker: HealthTracker }>();
  private readonly dirty = new Set<string>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  private entry(ref: SourceRef): HealthTracker {
    const key = keyOf(ref);
    const hit = this.trackers.get(key);
    if (hit !== undefined) return hit.tracker;
    const row = this.db
      .prepare('SELECT data FROM source_health WHERE portal_id = ? AND channel_id = ?')
      .get(ref.portalId, ref.channelId) as { data: string } | undefined;
    let data: unknown = null;
    try {
      data = row === undefined ? null : JSON.parse(row.data);
    } catch {
      // Ligne illisible : la source repart d'une santé inconnue.
    }
    const tracker = HealthTracker.fromJSON(data);
    this.trackers.set(key, { ref, tracker });
    return tracker;
  }

  record(ref: SourceRef, event: HealthEvent): void {
    this.entry(ref).record(event);
    this.dirty.add(keyOf(ref));
  }

  health(ref: SourceRef): SourceHealth {
    return this.entry(ref).health(this.now());
  }

  flush(): void {
    if (this.dirty.size === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO source_health (portal_id, channel_id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(portal_id, channel_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
    const at = this.now();
    this.db.transaction(() => {
      for (const key of this.dirty) {
        const e = this.trackers.get(key);
        if (e === undefined) continue;
        try {
          upsert.run(e.ref.portalId, e.ref.channelId, JSON.stringify(e.tracker.toJSON()), at);
        } catch {
          // Portail supprimé entre-temps (clé étrangère) : rien à garder.
        }
      }
    })();
    this.dirty.clear();
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}

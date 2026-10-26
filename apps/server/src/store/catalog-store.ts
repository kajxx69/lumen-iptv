import type { GenreDto } from '@lumen/protocol';
import type { Db } from './database.js';

/** Chaîne telle que conservée : le DTO public plus la commande de lecture, qui reste ici. */
export interface StoredChannel {
  id: string;
  name: string;
  number: number;
  genreId: string;
  /**
   * Logo : chemin seul (« /… ») s'il est servi par le portail, pour ne pas stocker son
   * adresse en clair ; URL complète s'il vient d'un tiers.
   */
  logo: string | null;
  epgId: string | null;
  archiveHours: number;
  censored: boolean;
  cmd: string;
}

export interface CatalogMeta {
  version: string;
  syncedAt: number;
  genres: GenreDto[];
}

export class CatalogStore {
  constructor(private readonly db: Db) {}

  meta(portalId: string): CatalogMeta | null {
    const row = this.db
      .prepare('SELECT version, synced_at, genres FROM catalog_meta WHERE portal_id = ?')
      .get(portalId) as { version: string; synced_at: number; genres: string } | undefined;
    return row === undefined
      ? null
      : { version: row.version, syncedAt: row.synced_at, genres: JSON.parse(row.genres) as GenreDto[] };
  }

  channels(portalId: string): StoredChannel[] {
    const rows = this.db
      .prepare('SELECT data FROM catalog_channels WHERE portal_id = ? ORDER BY position')
      .all(portalId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as StoredChannel);
  }

  channel(portalId: string, channelId: string): StoredChannel | null {
    const row = this.db
      .prepare('SELECT data FROM catalog_channels WHERE portal_id = ? AND channel_id = ?')
      .get(portalId, channelId) as { data: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.data) as StoredChannel);
  }

  /** Remplacement atomique : un client ne voit jamais un catalogue à moitié écrit. */
  replace(
    portalId: string,
    channels: StoredChannel[],
    genres: GenreDto[],
    version: string,
    now: number,
  ): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO catalog_channels (portal_id, channel_id, position, data) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM catalog_channels WHERE portal_id = ?').run(portalId);
      channels.forEach((c, i) => insert.run(portalId, c.id, i, JSON.stringify(c)));
      this.db
        .prepare(
          `INSERT INTO catalog_meta (portal_id, version, synced_at, genres) VALUES (?, ?, ?, ?)
           ON CONFLICT(portal_id) DO UPDATE SET version = excluded.version, synced_at = excluded.synced_at, genres = excluded.genres`,
        )
        .run(portalId, version, now, JSON.stringify(genres));
    })();
  }
}

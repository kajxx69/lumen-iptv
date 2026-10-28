import type { GenreDto } from '@lumen/protocol';
import type { Db } from './database.js';

export type VodKind = 'movie' | 'series';

/** Film tel que conservé : le DTO public plus la commande de lecture, qui reste ici. */
export interface StoredMovie {
  id: string;
  name: string;
  originalName: string;
  description: string;
  year: number | null;
  director: string;
  actors: string;
  rating: number | null;
  durationMin: number | null;
  categoryId: string;
  /** Affiche : chemin seul (« /… ») si le portail la sert, URL complète si elle vient d'un tiers. */
  poster: string | null;
  censored: boolean;
  cmd: string;
  /** Empreinte du nom : rapproche le même film d'un portail à l'autre (vue « Tous les portails »). */
  fingerprint: string;
}

export interface StoredSeries {
  id: string;
  name: string;
  description: string;
  year: number | null;
  categoryId: string;
  poster: string | null;
  censored: boolean;
  fingerprint: string;
}

export interface VodItemOf {
  movie: StoredMovie;
  series: StoredSeries;
}

export interface VodMeta {
  version: string;
  syncedAt: number;
  categories: GenreDto[];
}

/** Catalogues de films et de séries, un par portail et par genre de contenu. */
export class VodStore {
  constructor(private readonly db: Db) {}

  meta(portalId: string, kind: VodKind): VodMeta | null {
    const row = this.db
      .prepare('SELECT version, synced_at, categories FROM vod_meta WHERE portal_id = ? AND kind = ?')
      .get(portalId, kind) as { version: string; synced_at: number; categories: string } | undefined;
    return row === undefined
      ? null
      : {
          version: row.version,
          syncedAt: row.synced_at,
          categories: JSON.parse(row.categories) as GenreDto[],
        };
  }

  items<K extends VodKind>(portalId: string, kind: K): VodItemOf[K][] {
    const rows = this.db
      .prepare('SELECT data FROM vod_items WHERE portal_id = ? AND kind = ? ORDER BY position')
      .all(portalId, kind) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as VodItemOf[K]);
  }

  item<K extends VodKind>(portalId: string, kind: K, id: string): VodItemOf[K] | null {
    const row = this.db
      .prepare('SELECT data FROM vod_items WHERE portal_id = ? AND kind = ? AND item_id = ?')
      .get(portalId, kind, id) as { data: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.data) as VodItemOf[K]);
  }

  /** Remplacement atomique : un client ne voit jamais un catalogue à moitié écrit. */
  replace<K extends VodKind>(
    portalId: string,
    kind: K,
    items: readonly VodItemOf[K][],
    categories: GenreDto[],
    version: string,
    now: number,
  ): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO vod_items (portal_id, kind, item_id, position, data) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM vod_items WHERE portal_id = ? AND kind = ?').run(portalId, kind);
      items.forEach((item, i) => insert.run(portalId, kind, item.id, i, JSON.stringify(item)));
      this.db
        .prepare(
          `INSERT INTO vod_meta (portal_id, kind, version, synced_at, categories) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(portal_id, kind) DO UPDATE SET version = excluded.version,
             synced_at = excluded.synced_at, categories = excluded.categories`,
        )
        .run(portalId, kind, version, now, JSON.stringify(categories));
    })();
  }
}

import { type FavoriteDto, RECENTS_MAX, type RecentDto } from '@lumen/protocol';
import type { Db } from './database.js';

/** Favoris et chaînes récentes de chaque utilisateur. */
export class LibraryStore {
  constructor(private readonly db: Db) {}

  favorites(userId: string): FavoriteDto[] {
    const rows = this.db
      .prepare(
        'SELECT portal_id, channel_id, added_at FROM favorites WHERE user_id = ? ORDER BY added_at, rowid',
      )
      .all(userId) as { portal_id: string; channel_id: string; added_at: number }[];
    return rows.map((r) => ({ portalId: r.portal_id, channelId: r.channel_id, addedAt: r.added_at }));
  }

  /** Favoris de tous les comptes, sans doublon : ce sont les chaînes sondées en priorité. */
  allFavorites(): { portalId: string; channelId: string }[] {
    const rows = this.db
      .prepare('SELECT DISTINCT portal_id, channel_id FROM favorites ORDER BY portal_id, channel_id')
      .all() as { portal_id: string; channel_id: string }[];
    return rows.map((r) => ({ portalId: r.portal_id, channelId: r.channel_id }));
  }

  /** Idempotent : un favori déjà présent garde sa place. */
  addFavorite(userId: string, portalId: string, channelId: string, now: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO favorites (user_id, portal_id, channel_id, added_at) VALUES (?, ?, ?, ?)',
      )
      .run(userId, portalId, channelId, now);
  }

  removeFavorite(userId: string, portalId: string, channelId: string): void {
    this.db
      .prepare('DELETE FROM favorites WHERE user_id = ? AND portal_id = ? AND channel_id = ?')
      .run(userId, portalId, channelId);
  }

  recents(userId: string): RecentDto[] {
    const rows = this.db
      .prepare(
        'SELECT portal_id, channel_id, watched_at FROM recents WHERE user_id = ? ORDER BY watched_at DESC, rowid DESC LIMIT ?',
      )
      .all(userId, RECENTS_MAX) as { portal_id: string; channel_id: string; watched_at: number }[];
    return rows.map((r) => ({ portalId: r.portal_id, channelId: r.channel_id, watchedAt: r.watched_at }));
  }

  /** Chaîne regardée : remonte en tête ; au-delà de RECENTS_MAX, les plus anciennes partent. */
  touchRecent(userId: string, portalId: string, channelId: string, now: number): void {
    this.db.transaction(() => {
      // Deux zappings dans la même milliseconde doivent garder leur ordre.
      const latest = this.db
        .prepare('SELECT MAX(watched_at) AS m FROM recents WHERE user_id = ?')
        .get(userId) as {
        m: number | null;
      };
      const at = Math.max(now, (latest.m ?? 0) + 1);
      this.db
        .prepare(
          `INSERT INTO recents (user_id, portal_id, channel_id, watched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, portal_id, channel_id) DO UPDATE SET watched_at = excluded.watched_at`,
        )
        .run(userId, portalId, channelId, at);
      this.db
        .prepare(
          `DELETE FROM recents WHERE user_id = ? AND rowid NOT IN (
             SELECT rowid FROM recents WHERE user_id = ? ORDER BY watched_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(userId, userId, RECENTS_MAX);
    })();
  }
}

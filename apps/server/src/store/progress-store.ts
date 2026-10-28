import {
  PROGRESS_MAX,
  type ProgressDto,
  type ProgressKind,
  type ProgressUpdateRequest,
  isFinished,
} from '@lumen/protocol';
import type { Db } from './database.js';

interface ProgressRow {
  portal_id: string;
  kind: ProgressKind;
  item_id: string;
  series_id: string | null;
  season_id: string | null;
  position_s: number;
  duration_s: number;
  label: string | null;
  finished: number;
  updated_at: number;
}

const toDto = (r: ProgressRow): ProgressDto => ({
  kind: r.kind,
  portalId: r.portal_id,
  itemId: r.item_id,
  seriesId: r.series_id,
  seasonId: r.season_id,
  positionS: r.position_s,
  durationS: r.duration_s,
  label: r.label,
  finished: r.finished === 1,
  updatedAt: r.updated_at,
});

/** Positions de lecture des films et épisodes de chaque compte : reprise sur tous ses appareils. */
export class ProgressStore {
  constructor(private readonly db: Db) {}

  list(userId: string): ProgressDto[] {
    const rows = this.db
      .prepare('SELECT * FROM progress WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(userId, PROGRESS_MAX) as ProgressRow[];
    return rows.map(toDto);
  }

  /** Position enregistrée ; au-delà de PROGRESS_MAX titres, les plus anciens sont oubliés. */
  save(userId: string, update: ProgressUpdateRequest, now: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO progress (user_id, portal_id, kind, item_id, series_id, season_id, position_s,
             duration_s, label, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, portal_id, kind, item_id) DO UPDATE SET series_id = excluded.series_id,
             season_id = excluded.season_id, position_s = excluded.position_s, duration_s = excluded.duration_s,
             label = excluded.label, finished = excluded.finished, updated_at = excluded.updated_at`,
        )
        .run(
          userId,
          update.portalId,
          update.kind,
          update.itemId,
          update.seriesId,
          update.seasonId,
          update.positionS,
          update.durationS,
          update.label,
          isFinished(update.positionS, update.durationS) ? 1 : 0,
          now,
        );
      this.db
        .prepare(
          `DELETE FROM progress WHERE user_id = ? AND rowid NOT IN (
             SELECT rowid FROM progress WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(userId, userId, PROGRESS_MAX);
    })();
  }

  remove(userId: string, kind: ProgressKind, portalId: string, itemId: string): void {
    this.db
      .prepare('DELETE FROM progress WHERE user_id = ? AND kind = ? AND portal_id = ? AND item_id = ?')
      .run(userId, kind, portalId, itemId);
  }
}

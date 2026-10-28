import type { GridVerdict } from '@lumen/core/catalog';
import type { MergeOverrideDto } from '@lumen/protocol';
import type { Db } from './database.js';

const MERGE_ENABLED_KEY = 'merge.enabled';

export interface StoredVerdict {
  verdict: GridVerdict | null;
  similarity: number | null;
  checkedAt: number;
}

/**
 * Fusion multi-portails : réglage d'installation, corrections manuelles et avis des grilles
 * EPG. `revision` change à chaque écriture : la fusion en mémoire sait qu'elle doit se refaire.
 */
export class MergeStore {
  private rev = 0;

  constructor(private readonly db: Db) {}

  get revision(): number {
    return this.rev;
  }

  /** Active par défaut : l'utilisateur voit une chaîne unique dès qu'il a deux portails. */
  enabled(): boolean {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(MERGE_ENABLED_KEY) as
      { value: string } | undefined;
    return row === undefined ? true : row.value === 'true';
  }

  setEnabled(enabled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(MERGE_ENABLED_KEY, String(enabled));
    this.rev++;
  }

  overrides(): MergeOverrideDto[] {
    const rows = this.db
      .prepare('SELECT portal_id, channel_id, target FROM merge_overrides ORDER BY created_at')
      .all() as { portal_id: string; channel_id: string; target: string }[];
    return rows.map((r) => ({ portalId: r.portal_id, channelId: r.channel_id, target: r.target }));
  }

  setOverride(portalId: string, channelId: string, target: string | null, now: number): void {
    if (target === null) {
      this.db
        .prepare('DELETE FROM merge_overrides WHERE portal_id = ? AND channel_id = ?')
        .run(portalId, channelId);
    } else {
      this.db
        .prepare(
          `INSERT INTO merge_overrides (portal_id, channel_id, target, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(portal_id, channel_id) DO UPDATE SET target = excluded.target, created_at = excluded.created_at`,
        )
        .run(portalId, channelId, target, now);
    }
    this.rev++;
  }

  verdicts(): Map<string, StoredVerdict> {
    const rows = this.db
      .prepare('SELECT pair, verdict, similarity, checked_at FROM merge_verdicts')
      .all() as {
      pair: string;
      verdict: string | null;
      similarity: number | null;
      checked_at: number;
    }[];
    return new Map(
      rows.map((r) => [
        r.pair,
        {
          verdict: r.verdict === 'same' || r.verdict === 'different' ? r.verdict : null,
          similarity: r.similarity,
          checkedAt: r.checked_at,
        },
      ]),
    );
  }

  /** Seul un refus change la fusion : une vérification qui confirme ne la refait pas. */
  setVerdict(pair: string, verdict: StoredVerdict): void {
    const previous = this.db.prepare('SELECT verdict FROM merge_verdicts WHERE pair = ?').get(pair) as
      { verdict: string | null } | undefined;
    const changesMerge = (verdict.verdict === 'different') !== (previous?.verdict === 'different');
    this.db
      .prepare(
        `INSERT INTO merge_verdicts (pair, verdict, similarity, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pair) DO UPDATE SET verdict = excluded.verdict, similarity = excluded.similarity,
           checked_at = excluded.checked_at`,
      )
      .run(pair, verdict.verdict, verdict.similarity, verdict.checkedAt);
    if (changesMerge) this.rev++;
  }
}

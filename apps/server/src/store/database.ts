import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Migrations ordonnées : l'index + 1 est la version du schéma. Ne jamais modifier une entrée publiée. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- Tout ce qui identifie l'abonnement (URL, MAC, identifiants) est dans secret, chiffré.
  CREATE TABLE portals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE catalog_meta (
    portal_id TEXT PRIMARY KEY REFERENCES portals(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    genres TEXT NOT NULL
  );
  CREATE TABLE catalog_channels (
    portal_id TEXT NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (portal_id, channel_id)
  );
  CREATE INDEX catalog_channels_order ON catalog_channels (portal_id, position);
  `,
  // Bibliothèque personnelle : synchronisée entre les appareils d'un même compte.
  `
  CREATE TABLE favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portal_id TEXT NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, portal_id, channel_id)
  );
  CREATE TABLE recents (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portal_id TEXT NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    watched_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, portal_id, channel_id)
  );
  CREATE INDEX recents_by_user ON recents (user_id, watched_at);
  `,
];

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] ?? '');
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

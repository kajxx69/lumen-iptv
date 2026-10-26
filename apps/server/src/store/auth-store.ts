import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Role } from '@lumen/protocol';
import type { Db } from './database.js';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
}

interface UserRow {
  id: string;
  username: string;
  role: Role;
  password_hash: string;
}

const SESSION_TOKEN_BYTES = 32;
// Prolonger une session coûte une écriture : on ne le fait qu'une fois par heure au plus.
const SESSION_EXTEND_INTERVAL_MS = 3_600_000;

/** Seule l'empreinte du jeton est stockée : une copie de la base ne permet pas d'usurper une session. */
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export class AuthStore {
  constructor(
    private readonly db: Db,
    private readonly sessionTtlMs: number,
  ) {}

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  /** Renvoie null si le nom est déjà pris. */
  createUser(username: string, passwordHash: string, role: Role, now: number): AuthUser | null {
    const id = randomUUID();
    try {
      this.db
        .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, passwordHash, role, now);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
      throw err;
    }
    return { id, username, role };
  }

  findUserForLogin(username: string): (AuthUser & { passwordHash: string }) | null {
    const row = this.db
      .prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
    return row === undefined
      ? null
      : { id: row.id, username: row.username, role: row.role, passwordHash: row.password_hash };
  }

  createSession(userId: string, now: number): string {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    this.db
      .prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash(token), userId, now, now + this.sessionTtlMs);
    return token;
  }

  /** Utilisateur d'une session valide ; prolonge la session (expiration glissante). */
  resolveSession(token: string, now: number): AuthUser | null {
    const hash = tokenHash(token);
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.role, s.expires_at FROM auth_sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hash) as (Omit<UserRow, 'password_hash'> & { expires_at: number }) | undefined;
    if (row === undefined) return null;
    if (row.expires_at <= now) {
      this.deleteSession(token);
      return null;
    }
    if (row.expires_at - now < this.sessionTtlMs - SESSION_EXTEND_INTERVAL_MS) {
      this.db
        .prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
        .run(now + this.sessionTtlMs, hash);
    }
    return { id: row.id, username: row.username, role: row.role };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  purgeExpiredSessions(now: number): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  }
}

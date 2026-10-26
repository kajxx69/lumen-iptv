import { randomBytes } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { FakePortalConfig } from '../config.js';

export interface Session {
  token: string;
  mac: string;
  model: string;
  authenticated: boolean;
  lastSeenMs: number;
}

export type PlayKind = 'live' | 'vod' | 'archive';

export interface PlayGrant {
  token: string;
  sessionToken: string;
  kind: PlayKind;
  streamId: string;
  createdMs: number;
  used: boolean;
}

export type SessionCheck =
  { ok: true; session: Session } | { ok: false; reason: 'unknown' | 'expired' | 'mac_mismatch' };
export type PlayCheck =
  | { ok: true; grant: PlayGrant }
  | { ok: false; reason: 'unknown' | 'expired' | 'session_gone' | 'already_used' | 'mismatch' };

const TOKEN_BYTES = 16;
const RATE_WINDOW_MS = 1000;

const newToken = (): string => randomBytes(TOKEN_BYTES).toString('hex').toUpperCase();

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly grants = new Map<string, PlayGrant>();
  private readonly favorites = new Map<string, number[]>();
  private readonly rate = new Map<string, { windowStart: number; count: number }>();
  private readonly bans = new Map<string, number>();

  constructor(
    private readonly config: FakePortalConfig,
    private readonly clock: Clock,
  ) {}

  handshake(mac: string, model: string): Session {
    const session: Session = {
      token: newToken(),
      mac,
      model,
      authenticated: !this.config.requireDoAuth,
      lastSeenMs: this.clock.now(),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  check(token: string, mac: string): SessionCheck {
    const session = this.sessions.get(token);
    if (session === undefined) return { ok: false, reason: 'unknown' };
    const now = this.clock.now();
    if (now - session.lastSeenMs > this.config.sessionTokenTtlMs) {
      this.sessions.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (session.mac !== mac) return { ok: false, reason: 'mac_mismatch' };
    // Expiration à l'inactivité : le get_profile périodique du client maintient la session.
    session.lastSeenMs = now;
    return { ok: true, session };
  }

  expireAll(): void {
    this.sessions.clear();
    this.grants.clear();
  }

  grantPlay(session: Session, kind: PlayKind, streamId: string): PlayGrant {
    const grant: PlayGrant = {
      token: newToken(),
      sessionToken: session.token,
      kind,
      streamId,
      createdMs: this.clock.now(),
      used: false,
    };
    this.grants.set(grant.token, grant);
    return grant;
  }

  /**
   * Un lien de lecture doit être ouvert dans sa fenêtre de validité. Les flux TS et les
   * fichiers sont à usage unique (une reconnexion exige un nouveau create_link) ; le HLS
   * réutilise le même lien pour chaque playlist et segment tant que la session vit.
   */
  consumePlay(token: string, kind: PlayKind, streamId: string, reusable: boolean): PlayCheck {
    const grant = this.grants.get(token);
    if (grant === undefined) return { ok: false, reason: 'unknown' };
    if (grant.kind !== kind || grant.streamId !== streamId) return { ok: false, reason: 'mismatch' };
    if (!this.sessions.has(grant.sessionToken)) return { ok: false, reason: 'session_gone' };
    if (grant.used && !reusable) return { ok: false, reason: 'already_used' };
    if (!grant.used && this.clock.now() - grant.createdMs > this.config.playTokenTtlMs) {
      this.grants.delete(token);
      return { ok: false, reason: 'expired' };
    }
    grant.used = true;
    return { ok: true, grant };
  }

  favoritesOf(mac: string): number[] {
    return this.favorites.get(mac) ?? [];
  }

  setFavorites(mac: string, ids: number[]): void {
    this.favorites.set(mac, ids);
  }

  /** Vrai si la requête est acceptée ; au-delà du seuil, la MAC est bannie un temps. */
  admit(mac: string): boolean {
    const now = this.clock.now();
    const bannedUntil = this.bans.get(mac);
    if (bannedUntil !== undefined) {
      if (now < bannedUntil) return false;
      this.bans.delete(mac);
    }
    const entry = this.rate.get(mac);
    if (entry === undefined || now - entry.windowStart >= RATE_WINDOW_MS) {
      this.rate.set(mac, { windowStart: now, count: 1 });
      return true;
    }
    entry.count++;
    if (entry.count > this.config.apiRateLimitPerSecond) {
      this.bans.set(mac, now + this.config.macBanDurationMs);
      return false;
    }
    return true;
  }

  resetBans(): void {
    this.bans.clear();
    this.rate.clear();
  }
}

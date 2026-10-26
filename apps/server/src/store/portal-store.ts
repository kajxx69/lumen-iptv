import { randomUUID } from 'node:crypto';
import { DeviceModel } from '@lumen/protocol';
import { z } from 'zod';
import type { SecretBox } from '../security/secret-box.js';
import type { Db } from './database.js';

/** Tout ce qui permet d'utiliser l'abonnement : ne quitte jamais le serveur, chiffré au repos. */
export const PortalSecret = z.object({
  url: z.string(),
  mac: z.string(),
  device: DeviceModel,
  login: z.string().optional(),
  password: z.string().optional(),
});
export type PortalSecret = z.infer<typeof PortalSecret>;

export interface PortalRecord {
  id: string;
  name: string;
  createdAt: number;
  secret: PortalSecret;
}

interface PortalRow {
  id: string;
  name: string;
  secret: Buffer;
  created_at: number;
}

const context = (id: string): string => `portal:${id}`;

export class PortalStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  private decode(row: PortalRow): PortalRecord {
    const secret = PortalSecret.parse(JSON.parse(this.box.open(row.secret, context(row.id))));
    return { id: row.id, name: row.name, createdAt: row.created_at, secret };
  }

  create(name: string, secret: PortalSecret, now: number): PortalRecord {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO portals (id, name, secret, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, this.box.seal(JSON.stringify(secret), context(id)), now);
    return { id, name, createdAt: now, secret };
  }

  get(id: string): PortalRecord | null {
    const row = this.db.prepare('SELECT * FROM portals WHERE id = ?').get(id) as PortalRow | undefined;
    return row === undefined ? null : this.decode(row);
  }

  list(): PortalRecord[] {
    return (this.db.prepare('SELECT * FROM portals ORDER BY created_at').all() as PortalRow[]).map((r) =>
      this.decode(r),
    );
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM portals WHERE id = ?').run(id).changes > 0;
  }
}

import type { ChannelDto, GenreDto } from '@lumen/protocol';
import { Dexie, type EntityTable } from 'dexie';

/**
 * Catalogue d'un portail, conservé dans IndexedDB : l'application s'ouvre instantanément,
 * même hors ligne, puis revalide en arrière-plan (ETag : un catalogue inchangé ne coûte
 * qu'une réponse 304, aucun octet de liste).
 *
 * Un enregistrement par portail plutôt qu'une ligne par chaîne : relire 100 000 chaînes
 * d'un bloc est bien plus rapide que 100 000 lectures, et le catalogue change d'un bloc.
 */
export interface CachedCatalog {
  portalId: string;
  version: string;
  etag: string;
  syncedAt: number;
  channels: ChannelDto[];
  genres: GenreDto[];
}

class CatalogDb extends Dexie {
  catalogs!: EntityTable<CachedCatalog, 'portalId'>;

  constructor() {
    super('lumen');
    // Toute évolution du format passe par une nouvelle version : jamais de cache illisible.
    this.version(1).stores({ catalogs: 'portalId' });
  }
}

let db: CatalogDb | null = null;

/** IndexedDB peut être refusé (navigation privée stricte) : le cache devient alors inopérant. */
function open(): CatalogDb | null {
  try {
    db ??= new CatalogDb();
    return db;
  } catch {
    return null;
  }
}

export async function readCatalog(portalId: string): Promise<CachedCatalog | null> {
  try {
    return (await open()?.catalogs.get(portalId)) ?? null;
  } catch {
    return null;
  }
}

export async function writeCatalog(catalog: CachedCatalog): Promise<void> {
  try {
    await open()?.catalogs.put(catalog);
  } catch {
    // Quota dépassé ou base refusée : l'application continue, sans cache hors ligne.
  }
}

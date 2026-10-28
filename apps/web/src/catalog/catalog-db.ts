import type { ChannelDto, GenreDto, MovieSummaryDto, SeriesSummaryDto } from '@lumen/protocol';
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

export type VodKind = 'movie' | 'series';

/** Films ou séries d'un portail : même principe, un enregistrement par portail et par genre. */
export interface CachedVodCatalog {
  /** `portail:genre`. */
  key: string;
  portalId: string;
  kind: VodKind;
  version: string;
  etag: string;
  syncedAt: number;
  complete: boolean;
  categories: GenreDto[];
  items: (MovieSummaryDto | SeriesSummaryDto)[];
}

class CatalogDb extends Dexie {
  catalogs!: EntityTable<CachedCatalog, 'portalId'>;
  vodCatalogs!: EntityTable<CachedVodCatalog, 'key'>;

  constructor() {
    super('lumen');
    // Toute évolution du format passe par une nouvelle version : jamais de cache illisible.
    this.version(1).stores({ catalogs: 'portalId' });
    this.version(2).stores({ catalogs: 'portalId', vodCatalogs: 'key' });
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

export const vodCatalogKey = (portalId: string, kind: VodKind): string => `${portalId}:${kind}`;

export async function readVodCatalog(portalId: string, kind: VodKind): Promise<CachedVodCatalog | null> {
  try {
    return (await open()?.vodCatalogs.get(vodCatalogKey(portalId, kind))) ?? null;
  } catch {
    return null;
  }
}

export async function writeVodCatalog(catalog: CachedVodCatalog): Promise<void> {
  try {
    await open()?.vodCatalogs.put(catalog);
  } catch {
    // Quota dépassé ou base refusée : l'application continue, sans cache hors ligne.
  }
}

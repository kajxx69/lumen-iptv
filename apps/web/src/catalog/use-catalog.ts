import { type ChannelDto, ChannelListDto, type GenreDto, GenreDto as GenreSchema } from '@lumen/protocol';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import { request, requestJson } from '../api/client.js';
import { type CachedCatalog, readCatalog, writeCatalog } from './catalog-db.js';
import { ChannelSearch } from './search.js';

/** Le catalogue est revalidé en arrière-plan au plus toutes les 5 minutes (le serveur, lui, suit le portail). */
const CATALOG_STALE_MS = 5 * 60_000;

async function fetchCatalog(portalId: string): Promise<CachedCatalog> {
  const cached = await readCatalog(portalId);
  const res = await request(`/api/portals/${encodeURIComponent(portalId)}/channels`, {
    headers: cached === null ? {} : { 'If-None-Match': cached.etag },
  });
  if (res.status === 304 && cached !== null) return cached;
  const list = ChannelListDto.parse(await res.json());
  const genres = await requestJson(
    z.array(GenreSchema),
    `/api/portals/${encodeURIComponent(portalId)}/genres`,
  );
  const fresh: CachedCatalog = {
    portalId,
    version: list.version,
    etag: res.headers.get('etag') ?? `"${list.version}"`,
    syncedAt: list.syncedAt,
    channels: list.channels,
    genres,
  };
  await writeCatalog(fresh);
  return fresh;
}

/**
 * Index et tables dérivés d'une version de catalogue. Mémorisés par version : la copie
 * locale puis sa revalidation identique (304) ne reconstruisent pas l'index de recherche.
 */
const builtCatalogs = new Map<string, Omit<Catalog, 'fromCache'>>();
/** Versions gardées en mémoire : la courante et la précédente (le temps d'une transition). */
const BUILT_CATALOGS_KEPT = 2;

function built(source: CachedCatalog): Omit<Catalog, 'fromCache'> {
  const key = `${source.portalId}:${source.version}`;
  const hit = builtCatalogs.get(key);
  if (hit !== undefined) return hit;
  const channels = source.channels.filter((c) => !c.censored);
  const result = {
    channels,
    genres: source.genres.filter((g) => !g.censored),
    byId: new Map(channels.map((c) => [c.id, c])),
    search: new ChannelSearch(channels.map((c) => ({ key: c.id, name: c.name, number: c.number }))),
    syncedAt: source.syncedAt,
  };
  builtCatalogs.set(key, result);
  for (const old of [...builtCatalogs.keys()].slice(0, -BUILT_CATALOGS_KEPT)) builtCatalogs.delete(old);
  return result;
}

export interface Catalog {
  channels: ChannelDto[];
  genres: GenreDto[];
  byId: Map<string, ChannelDto>;
  search: ChannelSearch;
  /** Copie locale affichée faute de réseau (ou en attendant la revalidation). */
  fromCache: boolean;
  syncedAt: number;
}

/**
 * Catalogue d'un portail : la copie IndexedDB s'affiche aussitôt (hors ligne compris),
 * la revalidation réseau la remplace sans clignotement quand elle aboutit.
 * Les chaînes marquées « adulte » par le portail sont écartées tant que le contrôle
 * parental n'existe pas.
 */
export function useCatalog(portalId: string | null): {
  catalog: Catalog | null;
  loading: boolean;
  error: Error | null;
} {
  const cache = useQuery({
    queryKey: ['catalog-cache', portalId],
    queryFn: () => (portalId === null ? null : readCatalog(portalId)),
    enabled: portalId !== null,
    staleTime: Infinity,
  });
  const network = useQuery({
    queryKey: ['catalog', portalId],
    queryFn: () => fetchCatalog(portalId ?? ''),
    enabled: portalId !== null,
    staleTime: CATALOG_STALE_MS,
  });
  const source = network.data ?? cache.data ?? null;
  const fromCache = network.data === undefined;
  const catalog = useMemo(
    (): Catalog | null => (source === null ? null : { ...built(source), fromCache }),
    [source, fromCache],
  );
  return {
    catalog,
    loading: catalog === null && (cache.isLoading || network.isLoading),
    error: catalog === null ? network.error : null,
  };
}

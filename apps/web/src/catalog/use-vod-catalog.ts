import {
  type GenreDto,
  MovieListDto,
  type MovieSummaryDto,
  SeriesListDto,
  type SeriesSummaryDto,
  type VodSourceDto,
} from '@lumen/protocol';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { request } from '../api/client.js';
import {
  type CachedVodCatalog,
  type VodKind,
  readVodCatalog,
  vodCatalogKey,
  writeVodCatalog,
} from './catalog-db.js';
import { ChannelSearch } from './search.js';

/** Revalidé en arrière-plan au plus toutes les 5 minutes (le serveur, lui, suit le portail). */
const VOD_STALE_MS = 5 * 60_000;
/**
 * Premier chargement d'un grand portail : le serveur lit encore son catalogue page par page.
 * La liste est relue à ce rythme et grandit sous les yeux du spectateur.
 */
const PARTIAL_REFRESH_MS = 3000;

type ItemOf<K extends VodKind> = K extends 'movie' ? MovieSummaryDto : SeriesSummaryDto;

const listPath = (portalId: string, kind: VodKind): string =>
  `/api/portals/${encodeURIComponent(portalId)}/${kind === 'movie' ? 'movies' : 'series'}`;

async function fetchVod(portalId: string, kind: VodKind): Promise<CachedVodCatalog> {
  const cached = await readVodCatalog(portalId, kind);
  const res = await request(listPath(portalId, kind), {
    headers: cached === null ? {} : { 'If-None-Match': cached.etag },
  });
  if (res.status === 304 && cached !== null) return cached;
  const list = (kind === 'movie' ? MovieListDto : SeriesListDto).parse(await res.json());
  const fresh: CachedVodCatalog = {
    key: vodCatalogKey(portalId, kind),
    portalId,
    kind,
    version: list.version,
    etag: res.headers.get('etag') ?? `"${list.version}"`,
    syncedAt: list.syncedAt,
    complete: list.complete,
    categories: list.categories,
    items: list.items,
  };
  // Une liste encore partielle n'est pas gardée : la copie locale est toujours complète.
  if (list.complete) await writeVodCatalog(fresh);
  return fresh;
}

export interface VodCatalog<T extends MovieSummaryDto | SeriesSummaryDto> {
  items: T[];
  categories: GenreDto[];
  byId: Map<string, T>;
  search: ChannelSearch;
  /** Faux tant que le serveur lit encore le catalogue du portail. */
  complete: boolean;
}

/** Index dérivés d'une version : une revalidation identique (304) ne reconstruit rien. */
const built = new Map<string, VodCatalog<MovieSummaryDto | SeriesSummaryDto>>();
/** Versions gardées en mémoire : films et séries de la vue courante, et leur version précédente. */
const BUILT_KEPT = 4;

function build(source: CachedVodCatalog): VodCatalog<MovieSummaryDto | SeriesSummaryDto> {
  const key = `${source.key}:${source.version}`;
  const hit = built.get(key);
  if (hit !== undefined) return hit;
  // Contenus « adulte » du portail écartés tant que le contrôle parental n'existe pas.
  const items = source.items.filter((i) => !i.censored);
  const result = {
    items,
    categories: source.categories.filter((c) => !c.censored),
    byId: new Map(items.map((i) => [i.id, i])),
    search: new ChannelSearch(items.map((i) => ({ key: i.id, name: i.name, number: i.year }))),
    complete: source.complete,
  };
  built.set(key, result);
  for (const old of [...built.keys()].slice(0, -BUILT_KEPT)) built.delete(old);
  return result;
}

/**
 * Films ou séries de la vue courante : la copie IndexedDB s'affiche aussitôt (hors ligne
 * compris), la revalidation la remplace quand elle aboutit.
 */
export function useVodCatalog<K extends VodKind>(
  portalId: string | null,
  kind: K,
): { catalog: VodCatalog<ItemOf<K>> | null; loading: boolean; error: Error | null } {
  const cache = useQuery({
    queryKey: ['vod-cache', portalId, kind],
    queryFn: () => (portalId === null ? null : readVodCatalog(portalId, kind)),
    enabled: portalId !== null,
    staleTime: Infinity,
  });
  const network = useQuery({
    queryKey: ['vod', portalId, kind],
    queryFn: () => fetchVod(portalId ?? '', kind),
    enabled: portalId !== null,
    staleTime: VOD_STALE_MS,
    refetchInterval: (query) => (query.state.data?.complete === false ? PARTIAL_REFRESH_MS : false),
  });
  const source = network.data ?? cache.data ?? null;
  const catalog = useMemo(
    () => (source === null ? null : (build(source) as VodCatalog<ItemOf<K>>)),
    [source],
  );
  return {
    catalog,
    loading: catalog === null && (cache.isLoading || network.isLoading),
    error: catalog === null ? network.error : null,
  };
}

/**
 * Où trouver un titre : son portail préféré (vue « Tous les portails »), ou la vue courante.
 * Les autres portails qui le proposent servent de secours à la lecture.
 */
export function primarySource(
  viewPortalId: string,
  item: Pick<MovieSummaryDto, 'id' | 'sources'>,
): VodSourceDto & { alternatives: VodSourceDto[] } {
  const [first, ...rest] = item.sources ?? [];
  return first === undefined
    ? { portalId: viewPortalId, id: item.id, alternatives: [] }
    : { ...first, alternatives: rest };
}

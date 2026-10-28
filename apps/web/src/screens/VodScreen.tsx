import type { MovieSummaryDto, SeriesSummaryDto } from '@lumen/protocol';
import { useDeferredValue, useMemo, useState } from 'react';
import { findProgress, useProgress } from '../api/vod-queries.js';
import type { VodKind } from '../catalog/catalog-db.js';
import { primarySource, useVodCatalog } from '../catalog/use-vod-catalog.js';
import { NoPortal } from '../components/NoPortal.js';
import { type PosterItem, PosterGrid } from '../components/PosterGrid.js';
import { navigate } from '../state/router.js';
import { useCurrentPortal } from '../state/use-current-portal.js';

const ALL_CATEGORIES = null;

const subtitle = (item: MovieSummaryDto | SeriesSummaryDto): string | null => {
  const parts: string[] = [];
  if (item.year !== null) parts.push(String(item.year));
  if ('durationMin' in item && item.durationMin !== null) parts.push(`${item.durationMin} min`);
  return parts.length === 0 ? null : parts.join(' · ');
};

/** Films ou séries : catégories, grille d'affiches virtualisée, recherche instantanée. */
export function VodScreen({ kind, category }: { kind: VodKind; category: string | null }) {
  const { portal, loading: portalsLoading } = useCurrentPortal();
  const portalId = portal?.id ?? null;
  const { catalog, loading, error } = useVodCatalog(portalId, kind);
  const progress = useProgress();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const noun = kind === 'movie' ? 'film' : 'série';

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of catalog?.items ?? []) map.set(i.categoryId, (map.get(i.categoryId) ?? 0) + 1);
    return map;
  }, [catalog]);

  const shown = useMemo((): PosterItem[] => {
    if (catalog === null || portalId === null) return [];
    const list: (MovieSummaryDto | SeriesSummaryDto)[] =
      deferredQuery.trim() !== ''
        ? catalog.search
            .search(deferredQuery)
            .map((id) => catalog.byId.get(id))
            .filter((i): i is MovieSummaryDto | SeriesSummaryDto => i !== undefined)
        : category === ALL_CATEGORIES
          ? catalog.items
          : catalog.items.filter((i) => i.categoryId === category);
    return list.map((i) => {
      const source = primarySource(portalId, i);
      const saved =
        kind === 'movie' ? findProgress(progress.data, 'movie', source.portalId, source.id) : undefined;
      return {
        key: i.id,
        title: i.name,
        subtitle: subtitle(i),
        poster: i.poster,
        progress:
          saved === undefined || saved.finished || saved.durationS <= 0
            ? null
            : saved.positionS / saved.durationS,
      };
    });
  }, [catalog, deferredQuery, category, portalId, kind, progress.data]);

  if (!portalsLoading && portal === null) return <NoPortal />;
  if (catalog === null || portalId === null) {
    return (
      <div className="empty">
        {loading
          ? `Chargement des ${kind === 'movie' ? 'films' : 'séries'}…`
          : `Catalogue indisponible : ${error?.message ?? ''}`}
      </div>
    );
  }

  const categoryButton = (id: string | null, label: string, count: number) => (
    <button
      key={id ?? 'all'}
      type="button"
      className="genre"
      data-nav
      aria-pressed={category === id}
      onClick={() => {
        setQuery('');
        navigate({ name: kind === 'movie' ? 'movies' : 'series', category: id }, { replace: true });
      }}
    >
      <span>{label}</span>
      <span className="genre-count">{count}</span>
    </button>
  );

  const open = (item: PosterItem): void => {
    const summary = catalog.byId.get(item.key);
    if (summary === undefined) return;
    const source = primarySource(portalId, summary);
    navigate(
      kind === 'movie'
        ? { name: 'movie', portalId: source.portalId, movieId: source.id }
        : { name: 'show', portalId: source.portalId, seriesId: source.id, seasonId: null },
    );
  };

  return (
    <div className="live">
      <nav className="sidebar" aria-label="Catégories">
        {categoryButton(ALL_CATEGORIES, 'Toutes', catalog.items.length)}
        {catalog.categories
          .filter((c) => (counts.get(c.id) ?? 0) > 0)
          .map((c) => categoryButton(c.id, c.title, counts.get(c.id) ?? 0))}
      </nav>
      <section className="list-pane" aria-label={kind === 'movie' ? 'Films' : 'Séries'}>
        <div className="search">
          <input
            type="search"
            data-nav
            placeholder={`Rechercher un${kind === 'movie' ? '' : 'e'} ${noun}, une année`}
            aria-label={`Rechercher un${kind === 'movie' ? '' : 'e'} ${noun}`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          {!catalog.complete && (
            <span className="programme-now" role="status">
              Catalogue en cours de lecture chez le portail : {catalog.items.length} titres pour l’instant…
            </span>
          )}
        </div>
        <PosterGrid
          items={shown}
          onOpen={open}
          emptyText={
            deferredQuery !== ''
              ? `Aucun${kind === 'movie' ? '' : 'e'} ${noun} ne correspond à « ${deferredQuery} ».`
              : `Aucun${kind === 'movie' ? '' : 'e'} ${noun} dans cette catégorie.`
          }
        />
      </section>
    </div>
  );
}

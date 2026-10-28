import type { ChannelDto, MovieSummaryDto, SeriesSummaryDto } from '@lumen/protocol';
import { useDeferredValue, useMemo, useState } from 'react';
import { useCatalog } from '../catalog/use-catalog.js';
import { type VodCatalog, primarySource, useVodCatalog } from '../catalog/use-vod-catalog.js';
import { ChannelLogo } from '../components/ChannelLogo.js';
import { NoPortal } from '../components/NoPortal.js';
import { PosterTile } from '../components/PosterGrid.js';
import { navigate } from '../state/router.js';
import { useCurrentPortal } from '../state/use-current-portal.js';

/** Résultats montrés par rubrique : de quoi choisir d'un coup d'œil, l'écran de la rubrique fait le reste. */
const RESULTS_PER_SECTION = 12;

function found<T extends MovieSummaryDto | SeriesSummaryDto>(
  catalog: VodCatalog<T> | null,
  query: string,
): T[] {
  if (catalog === null || query.trim() === '') return [];
  return catalog.search
    .search(query)
    .slice(0, RESULTS_PER_SECTION)
    .map((id) => catalog.byId.get(id))
    .filter((i): i is T => i !== undefined);
}

/** Recherche globale instantanée : chaînes, films et séries, sans réseau (index locaux). */
export function SearchScreen({ query: initial }: { query: string }) {
  const { portal, loading } = useCurrentPortal();
  const portalId = portal?.id ?? null;
  const live = useCatalog(portalId);
  const movies = useVodCatalog(portalId, 'movie');
  const series = useVodCatalog(portalId, 'series');
  const [query, setQuery] = useState(initial);
  const deferred = useDeferredValue(query);

  const channels = useMemo((): ChannelDto[] => {
    const c = live.catalog;
    if (c === null || deferred.trim() === '') return [];
    return c.search
      .search(deferred)
      .slice(0, RESULTS_PER_SECTION)
      .map((id) => c.byId.get(id))
      .filter((x): x is ChannelDto => x !== undefined);
  }, [live.catalog, deferred]);
  const movieHits = useMemo(() => found(movies.catalog, deferred), [movies.catalog, deferred]);
  const seriesHits = useMemo(() => found(series.catalog, deferred), [series.catalog, deferred]);

  if (!loading && portal === null) return <NoPortal />;
  if (portalId === null) return <div className="empty">Chargement…</div>;
  const nothing = deferred.trim() !== '' && channels.length + movieHits.length + seriesHits.length === 0;

  return (
    <div className="search-screen screen">
      <div className="search">
        <input
          type="search"
          data-nav
          data-nav-default
          // Écran de recherche : la saisie est le seul geste attendu.
          autoFocus
          placeholder="Chaîne, film, série, année…"
          aria-label="Rechercher partout"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            navigate({ name: 'search', query: e.target.value }, { replace: true });
          }}
        />
      </div>
      {nothing && <p className="empty">Rien ne correspond à « {deferred} ».</p>}
      {channels.length > 0 && (
        <section aria-label="Chaînes" data-testid="search-channels">
          <h2>Chaînes</h2>
          <div className="tiles">
            {channels.map((c) => (
              <button
                key={c.id}
                type="button"
                className="tile"
                data-nav
                onClick={() => {
                  navigate({ name: 'watch', portalId, channelId: c.id });
                }}
              >
                <ChannelLogo src={c.logo} name={c.name} />
                <span className="tile-name">{c.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {movieHits.length > 0 && (
        <section aria-label="Films" data-testid="search-movies">
          <h2>Films</h2>
          <div className="poster-strip">
            {movieHits.map((m) => (
              <PosterTile
                key={m.id}
                item={{
                  key: m.id,
                  title: m.name,
                  subtitle: m.year === null ? null : String(m.year),
                  poster: m.poster,
                  progress: null,
                }}
                onOpen={() => {
                  const s = primarySource(portalId, m);
                  navigate({ name: 'movie', portalId: s.portalId, movieId: s.id });
                }}
              />
            ))}
          </div>
        </section>
      )}
      {seriesHits.length > 0 && (
        <section aria-label="Séries" data-testid="search-series">
          <h2>Séries</h2>
          <div className="poster-strip">
            {seriesHits.map((x) => (
              <PosterTile
                key={x.id}
                item={{
                  key: x.id,
                  title: x.name,
                  subtitle: x.year === null ? null : String(x.year),
                  poster: x.poster,
                  progress: null,
                }}
                onOpen={() => {
                  const s = primarySource(portalId, x);
                  navigate({ name: 'show', portalId: s.portalId, seriesId: s.id, seasonId: null });
                }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

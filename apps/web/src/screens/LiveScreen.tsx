import type { ChannelDto } from '@lumen/protocol';
import { useDeferredValue, useMemo, useState } from 'react';
import { favoriteKey, useFavorites, useToggleFavorite } from '../api/queries.js';
import { useCatalog } from '../catalog/use-catalog.js';
import { ChannelList } from '../components/ChannelList.js';
import { NoPortal } from '../components/NoPortal.js';
import { navigate } from '../state/router.js';
import { useCurrentPortal } from '../state/use-current-portal.js';

/** Genre virtuel « Favoris » dans la colonne des genres. */
export const FAVORITES_GENRE = 'favoris';
const ALL_GENRES = null;

/** TV en direct : genres, liste virtualisée avec programme en cours, recherche instantanée. */
export function LiveScreen({ genre }: { genre: string | null }) {
  const { portal, loading: portalsLoading } = useCurrentPortal();
  const portalId = portal?.id ?? null;
  const { catalog, loading, error } = useCatalog(portalId);
  const favorites = useFavorites();
  const toggle = useToggleFavorite();
  const [query, setQuery] = useState('');
  // La saisie reste fluide : la liste suit la frappe sans la bloquer.
  const deferredQuery = useDeferredValue(query);

  const favoriteSet = useMemo(
    () => new Set((favorites.data ?? []).map((f) => favoriteKey(f.portalId, f.channelId))),
    [favorites.data],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of catalog?.channels ?? []) map.set(c.genreId, (map.get(c.genreId) ?? 0) + 1);
    return map;
  }, [catalog]);

  const shown = useMemo((): ChannelDto[] => {
    if (catalog === null) return [];
    if (deferredQuery.trim() !== '') {
      return catalog.search
        .search(deferredQuery)
        .map((id) => catalog.byId.get(id))
        .filter((c): c is ChannelDto => c !== undefined);
    }
    if (genre === FAVORITES_GENRE) {
      return (favorites.data ?? [])
        .filter((f) => f.portalId === portalId)
        .map((f) => catalog.byId.get(f.channelId))
        .filter((c): c is ChannelDto => c !== undefined);
    }
    return genre === ALL_GENRES ? catalog.channels : catalog.channels.filter((c) => c.genreId === genre);
  }, [catalog, deferredQuery, genre, favorites.data, portalId]);

  if (!portalsLoading && portal === null) return <NoPortal />;
  if (catalog === null) {
    return (
      <div className="empty">
        {loading ? 'Chargement des chaînes…' : `Catalogue indisponible : ${error?.message ?? ''}`}
      </div>
    );
  }

  const genreButton = (id: string | null, label: string, count: number | null) => (
    <button
      key={id ?? 'all'}
      type="button"
      className="genre"
      data-nav
      aria-pressed={genre === id}
      onClick={() => {
        setQuery('');
        navigate({ name: 'tv', genre: id }, { replace: true });
      }}
    >
      <span>{label}</span>
      {count !== null && <span className="genre-count">{count}</span>}
    </button>
  );

  return (
    <div className="live">
      <nav className="sidebar" aria-label="Genres">
        {genreButton(ALL_GENRES, 'Toutes', catalog.channels.length)}
        {genreButton(FAVORITES_GENRE, '★ Favoris', null)}
        {catalog.genres
          .filter((g) => (counts.get(g.id) ?? 0) > 0)
          .map((g) => genreButton(g.id, g.title, counts.get(g.id) ?? 0))}
      </nav>
      <section className="list-pane" aria-label="Chaînes">
        <div className="search">
          <input
            type="search"
            data-nav
            placeholder="Rechercher une chaîne ou un numéro"
            aria-label="Rechercher une chaîne"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <ChannelList
          portalId={portalId ?? ''}
          channels={shown}
          favorites={favoriteSet}
          emptyText={
            deferredQuery !== ''
              ? `Aucune chaîne ne correspond à « ${deferredQuery} ».`
              : genre === FAVORITES_GENRE
                ? 'Aucun favori : ajoutez-en avec ☆ dans la liste.'
                : 'Aucune chaîne dans ce genre.'
          }
          onPlay={(c) => {
            if (portalId !== null) navigate({ name: 'watch', portalId, channelId: c.id });
          }}
          onToggleFavorite={(c, on) => {
            if (portalId !== null) toggle.mutate({ portalId, channelId: c.id, on });
          }}
        />
      </section>
    </div>
  );
}

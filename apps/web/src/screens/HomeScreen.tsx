import type { ChannelDto, MovieSummaryDto, ProgressDto, SeriesSummaryDto } from '@lumen/protocol';
import { useMemo } from 'react';
import { useFavorites, useRecents } from '../api/queries.js';
import { useProgress } from '../api/vod-queries.js';
import { useCatalog } from '../catalog/use-catalog.js';
import { type VodCatalog, useVodCatalog } from '../catalog/use-vod-catalog.js';
import { ChannelLogo } from '../components/ChannelLogo.js';
import { NoPortal } from '../components/NoPortal.js';
import { PosterTile } from '../components/PosterGrid.js';
import { navigate } from '../state/router.js';
import { useCurrentPortal } from '../state/use-current-portal.js';

function Tile({ portalId, channel, first }: { portalId: string; channel: ChannelDto; first?: boolean }) {
  return (
    <button
      type="button"
      className="tile"
      data-nav
      {...(first === true ? { 'data-nav-default': true } : {})}
      onClick={() => {
        navigate({ name: 'watch', portalId, channelId: channel.id });
      }}
    >
      <ChannelLogo src={channel.logo} name={channel.name} />
      <span className="tile-name">{channel.name}</span>
    </button>
  );
}

/** Titres « à reprendre » montrés au plus sur l'accueil. */
const CONTINUE_MAX = 12;

/** Titre d'une vue (portail ou « Tous les portails ») retrouvé par l'une de ses sources réelles. */
function bySource<T extends MovieSummaryDto | SeriesSummaryDto>(
  viewPortalId: string,
  catalog: VodCatalog<T> | null,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of catalog?.items ?? []) {
    const sources = item.sources ?? [{ portalId: viewPortalId, id: item.id }];
    for (const s of sources) map.set(`${s.portalId}:${s.id}`, item);
  }
  return map;
}

/**
 * Films et épisodes commencés et pas finis : la suite en un geste, sur tous les appareils
 * du compte. Les catalogues de films ne sont chargés que s'il y a quelque chose à reprendre :
 * ouvrir l'accueil ne coûte pas un catalogue entier en données mobiles.
 */
function ContinueRow({ portalId, first }: { portalId: string; first: boolean }) {
  const progress = useProgress();
  const pending = (progress.data ?? []).filter((p) => !p.finished);
  if (pending.length === 0) return null;
  return <ContinueList portalId={portalId} first={first} pending={pending} />;
}

function ContinueList({
  portalId,
  first,
  pending,
}: {
  portalId: string;
  first: boolean;
  pending: ProgressDto[];
}) {
  const movies = useVodCatalog(portalId, 'movie');
  const series = useVodCatalog(portalId, 'series');
  const movieMap = useMemo(() => bySource(portalId, movies.catalog), [portalId, movies.catalog]);
  const seriesMap = useMemo(() => bySource(portalId, series.catalog), [portalId, series.catalog]);
  const entries = pending
    .map((p): { p: ProgressDto; title: string; poster: string | null } | null => {
      if (p.kind === 'movie') {
        const m = movieMap.get(`${p.portalId}:${p.itemId}`);
        return m === undefined ? null : { p, title: m.name, poster: m.poster };
      }
      const sr = seriesMap.get(`${p.portalId}:${p.seriesId ?? ''}`);
      return sr === undefined ? null : { p, title: sr.name, poster: sr.poster };
    })
    .filter((e): e is { p: ProgressDto; title: string; poster: string | null } => e !== null)
    .slice(0, CONTINUE_MAX);
  if (entries.length === 0) return null;
  return (
    <>
      <h2>Reprendre</h2>
      <div className="poster-strip" data-testid="continue-row">
        {entries.map(({ p, title, poster }, i) => (
          <PosterTile
            key={`${p.kind}:${p.portalId}:${p.itemId}`}
            first={first && i === 0}
            item={{
              key: p.itemId,
              title,
              subtitle: p.label,
              poster,
              progress: p.durationS > 0 ? p.positionS / p.durationS : null,
            }}
            onOpen={() => {
              navigate({
                name: 'play',
                item:
                  p.kind === 'movie'
                    ? { kind: 'movie', portalId: p.portalId, movieId: p.itemId }
                    : {
                        kind: 'episode',
                        portalId: p.portalId,
                        seriesId: p.seriesId ?? '',
                        seasonId: p.seasonId ?? '',
                        episodeId: p.itemId,
                      },
                startS: null,
              });
            }}
          />
        ))}
      </div>
    </>
  );
}

/** Accueil : reprendre la dernière chaîne en un geste, puis films en cours, favoris et chaînes récentes. */
export function HomeScreen() {
  const { portal, loading } = useCurrentPortal();
  const portalId = portal?.id ?? null;
  const { catalog } = useCatalog(portalId);
  const favorites = useFavorites();
  const recents = useRecents();

  if (!loading && portal === null) return <NoPortal />;
  if (catalog === null || portalId === null) return <div className="empty">Chargement…</div>;

  // Une chaîne fusionnée n'apparaît qu'une fois, quelle que soit la source retenue.
  const resolve = (refs: readonly { portalId: string; channelId: string }[]): ChannelDto[] => [
    ...new Set(refs.map((r) => catalog.resolve(r)).filter((c): c is ChannelDto => c !== undefined)),
  ];
  const recentChannels = resolve(recents.data ?? []);
  const favoriteChannels = resolve(favorites.data ?? []);
  const last = recentChannels[0];

  return (
    <div className="home screen">
      {last !== undefined && (
        <button
          type="button"
          className="resume"
          data-nav
          data-nav-default
          onClick={() => {
            navigate({ name: 'watch', portalId, channelId: last.id });
          }}
        >
          <ChannelLogo src={last.logo} name={last.name} />
          <span>
            <small>Reprendre</small>
            <br />
            <strong>{last.name}</strong>
          </span>
        </button>
      )}
      <ContinueRow portalId={portalId} first={false} />
      <h2>Favoris</h2>
      {favoriteChannels.length === 0 ? (
        <p className="programme-now">Ajoutez des favoris avec ☆ depuis la liste des chaînes.</p>
      ) : (
        <div className="tiles">
          {favoriteChannels.map((c, i) => (
            <Tile key={c.id} portalId={portalId} channel={c} first={last === undefined && i === 0} />
          ))}
        </div>
      )}
      <h2>Regardées récemment</h2>
      {recentChannels.length === 0 ? (
        <p className="programme-now">
          Les chaînes que vous regardez apparaîtront ici, sur tous vos appareils.
        </p>
      ) : (
        <div className="tiles">
          {recentChannels.map((c) => (
            <Tile key={c.id} portalId={portalId} channel={c} />
          ))}
        </div>
      )}
      <h2>Parcourir</h2>
      <div className="actions">
        <button
          type="button"
          className="button primary"
          data-nav
          {...(last === undefined && favoriteChannels.length === 0 ? { 'data-nav-default': true } : {})}
          onClick={() => {
            navigate({ name: 'tv', genre: null });
          }}
        >
          Toutes les chaînes ({catalog.channels.length})
        </button>
        <button
          type="button"
          className="button"
          data-nav
          onClick={() => {
            navigate({ name: 'guide', genre: null });
          }}
        >
          Guide des programmes
        </button>
        <button
          type="button"
          className="button"
          data-nav
          onClick={() => {
            navigate({ name: 'movies', category: null });
          }}
        >
          Films
        </button>
        <button
          type="button"
          className="button"
          data-nav
          onClick={() => {
            navigate({ name: 'series', category: null });
          }}
        >
          Séries
        </button>
      </div>
    </div>
  );
}

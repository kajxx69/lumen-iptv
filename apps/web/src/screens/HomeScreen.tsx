import type { ChannelDto } from '@lumen/protocol';
import { useFavorites, useRecents } from '../api/queries.js';
import { useCatalog } from '../catalog/use-catalog.js';
import { ChannelLogo } from '../components/ChannelLogo.js';
import { NoPortal } from '../components/NoPortal.js';
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

/** Accueil : reprendre la dernière chaîne en un geste, puis favoris et chaînes récentes. */
export function HomeScreen() {
  const { portal, loading } = useCurrentPortal();
  const portalId = portal?.id ?? null;
  const { catalog } = useCatalog(portalId);
  const favorites = useFavorites();
  const recents = useRecents();

  if (!loading && portal === null) return <NoPortal />;
  if (catalog === null || portalId === null) return <div className="empty">Chargement…</div>;

  const resolve = (refs: readonly { portalId: string; channelId: string }[]): ChannelDto[] =>
    refs
      .filter((r) => r.portalId === portalId)
      .map((r) => catalog.byId.get(r.channelId))
      .filter((c): c is ChannelDto => c !== undefined);
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
      </div>
    </div>
  );
}

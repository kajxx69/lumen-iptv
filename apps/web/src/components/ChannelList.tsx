import type { ChannelDto } from '@lumen/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { favoriteKey } from '../api/queries.js';
import { useEpg } from '../epg/epg-store.js';
import { nowNext } from '../epg/layout.js';
import { ChannelLogo } from './ChannelLogo.js';

/** Hauteur d'une ligne (px), identique à --row-height : la liste virtualisée en dépend. */
export const ROW_HEIGHT_PX = 64;
/**
 * Lignes rendues hors écran de part et d'autre : de quoi tenir une flèche maintenue sur
 * la télécommande, la navigation spatiale trouvant toujours la ligne suivante dans le DOM.
 */
const OVERSCAN_ROWS = 6;

interface Props {
  portalId: string;
  channels: readonly ChannelDto[];
  favorites: ReadonlySet<string>;
  onPlay: (channel: ChannelDto) => void;
  onToggleFavorite: (channel: ChannelDto, on: boolean) => void;
  emptyText: string;
}

/**
 * Liste de chaînes virtualisée : 100 000 entrées, quelques dizaines de lignes dans le DOM.
 * Chaque ligne affiche le programme en cours, chargé pour les seules lignes visibles.
 */
export function ChannelList({ portalId, channels, favorites, onPlay, onToggleFavorite, emptyText }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });
  const items = virtualizer.getVirtualItems();
  const visibleIds = items.map((i) => channels[i.index]?.id ?? '').filter((id) => id !== '');
  const epg = useEpg(portalId, visibleIds);
  const now = Date.now();

  if (channels.length === 0) return <div className="empty">{emptyText}</div>;
  return (
    <div ref={parent} className="virtual" data-testid="channel-list">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((item) => {
          const channel = channels[item.index];
          if (channel === undefined) return null;
          const programme = nowNext(epg(channel.id) ?? [], now);
          const favorite = favorites.has(favoriteKey(portalId, channel.id));
          return (
            <div
              key={channel.id}
              className="channel-row"
              style={{ transform: `translateY(${item.start}px)` }}
              data-testid="channel-row"
            >
              <button
                type="button"
                className="channel-main"
                data-nav
                {...(item.index === 0 ? { 'data-nav-default': true } : {})}
                onClick={() => {
                  onPlay(channel);
                }}
                aria-label={`${channel.number} ${channel.name}${programme.now === null ? '' : `, en cours : ${programme.now.title}`}`}
              >
                <span className="channel-number">{channel.number}</span>
                <ChannelLogo src={channel.logo} name={channel.name} />
                <span className="channel-text">
                  <span className="channel-name">{channel.name}</span>
                  {programme.now !== null && (
                    <>
                      <span className="programme-now">{programme.now.title}</span>
                      <span className="progress">
                        <span style={{ width: `${Math.round(programme.progress * 100)}%` }} />
                      </span>
                    </>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="star"
                data-nav
                aria-pressed={favorite}
                aria-label={
                  favorite ? `Retirer ${channel.name} des favoris` : `Ajouter ${channel.name} aux favoris`
                }
                onClick={() => {
                  onToggleFavorite(channel, !favorite);
                }}
              >
                {favorite ? '★' : '☆'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

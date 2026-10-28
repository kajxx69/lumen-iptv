import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';

/** Largeur minimale d'une affiche (px) : 2 colonnes sur un téléphone, 8 à 10 sur un téléviseur. */
const POSTER_MIN_WIDTH_PX = 150;
const GAP_PX = 12;
/** Affiche au format cinéma (2:3), puis deux lignes de légende. */
const POSTER_RATIO = 1.5;
const CAPTION_PX = 48;
const MIN_COLUMNS = 2;
/** Rangées rendues hors écran : une flèche maintenue trouve toujours la suivante dans le DOM. */
const OVERSCAN_ROWS = 2;

export interface PosterItem {
  key: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
  /** Avancement de la lecture (0–1), ou null s'il n'y en a pas. */
  progress: number | null;
}

/** Affiche chargée paresseusement, avec le titre en repli (affiche absente ou cassée). */
export function Poster({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) {
    return (
      <span className="poster-fallback" aria-hidden="true">
        {title}
      </span>
    );
  }
  return (
    <img
      className="poster"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

export function PosterTile({
  item,
  onOpen,
  first,
}: {
  item: PosterItem;
  onOpen: () => void;
  first?: boolean;
}) {
  return (
    <button
      type="button"
      className="poster-tile"
      data-nav
      data-testid="poster-tile"
      {...(first === true ? { 'data-nav-default': true } : {})}
      onClick={onOpen}
    >
      <span className="poster-frame">
        <Poster src={item.poster} title={item.title} />
        {item.progress !== null && (
          <span className="poster-progress" aria-hidden="true">
            <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="poster-title">{item.title}</span>
      {item.subtitle !== null && <span className="poster-subtitle">{item.subtitle}</span>}
    </button>
  );
}

/**
 * Grille d'affiches virtualisée : des dizaines de milliers de titres, quelques rangées
 * dans le DOM. Le nombre de colonnes suit la largeur de l'écran.
 */
export function PosterGrid({
  items,
  onOpen,
  emptyText,
}: {
  items: readonly PosterItem[];
  onOpen: (item: PosterItem) => void;
  emptyText: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = parent.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  const columns = Math.max(MIN_COLUMNS, Math.floor((width + GAP_PX) / (POSTER_MIN_WIDTH_PX + GAP_PX)));
  const tileWidth = width === 0 ? POSTER_MIN_WIDTH_PX : (width - GAP_PX * (columns - 1)) / columns;
  const rowHeight = Math.round(tileWidth * POSTER_RATIO + CAPTION_PX + GAP_PX);
  const rows = Math.ceil(items.length / columns);
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parent.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  return (
    <div ref={parent} className="virtual poster-grid" data-testid="poster-grid">
      {items.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.index}
              className="poster-row"
              style={{
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: GAP_PX,
              }}
            >
              {items.slice(row.index * columns, (row.index + 1) * columns).map((item, i) => (
                <PosterTile
                  key={item.key}
                  item={item}
                  first={row.index === 0 && i === 0}
                  onOpen={() => {
                    onOpen(item);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

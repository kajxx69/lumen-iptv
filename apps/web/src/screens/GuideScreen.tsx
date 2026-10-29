import type { ChannelDto, EpgEntryDto } from '@lumen/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCatalog } from '../catalog/use-catalog.js';
import { ChannelLogo } from '../components/ChannelLogo.js';
import { NoPortal } from '../components/NoPortal.js';
import { ROW_HEIGHT_PX } from '../components/ChannelList.js';
import { useEpg } from '../epg/epg-store.js';
import { GUIDE_STEP_MS, formatTime, guideWindow, layoutProgrammes } from '../epg/layout.js';
import { actionForKey } from '../nav/spatial.js';
import { focusDefault } from '../nav/use-dpad.js';
import { navigate } from '../state/router.js';
import { useCurrentPortal } from '../state/use-current-portal.js';

/** Largeur d'une minute : une demi-heure fait 150 px, un titre court y tient. */
const PX_PER_MINUTE = 5;
/** Heures affichées : la soirée en cours d'un coup d'œil. */
const GUIDE_HOURS = 4;
/**
 * Heures passées, à gauche du présent : les émissions à revoir (archive du portail). Le guide
 * s'ouvre sur le présent ; on y revient en défilant vers la gauche.
 */
const GUIDE_PAST_HOURS = 2;
const MINUTE_MS = 60_000;
/** Hauteur de la règle des heures (px), identique au CSS. */
const RULER_HEIGHT_PX = 36;
/** Largeur de la colonne des chaînes (px), identique à --sidebar-width. */
const CHANNEL_COLUMN_PX = 220;
const OVERSCAN_ROWS = 4;
/** La ligne « maintenant » avance toute seule. */
const NOW_REFRESH_MS = 30_000;

interface Selected {
  channel: ChannelDto;
  entry: EpgEntryDto;
}

/** Guide en grille : chaînes en lignes (virtualisées), 2 h passées et 4 h à venir, ligne du présent. */
export function GuideScreen({ genre }: { genre: string | null }) {
  const { portal, loading: portalsLoading } = useCurrentPortal();
  const portalId = portal?.id ?? null;
  const { catalog, loading } = useCatalog(portalId);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<Selected | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, NOW_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const win = useMemo(() => {
    const ahead = guideWindow(now, GUIDE_HOURS);
    return { start: ahead.start - GUIDE_PAST_HOURS * 60 * MINUTE_MS, end: ahead.end };
  }, [now]);
  const timelineWidth = (GUIDE_HOURS + GUIDE_PAST_HOURS) * 60 * PX_PER_MINUTE;

  const channels = useMemo(
    () =>
      catalog === null
        ? []
        : genre === null
          ? catalog.channels
          : catalog.channels.filter((c) => c.genreId === genre),
    [catalog, genre],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
    scrollMargin: RULER_HEIGHT_PX,
  });
  const items = virtualizer.getVirtualItems();
  const epg = useEpg(
    portalId,
    items.map((i) => channels[i.index]?.id ?? '').filter((id) => id !== ''),
  );

  // Ouverture sur le présent : les heures passées attendent à gauche.
  const hasCatalog = catalog !== null;
  useEffect(() => {
    if (hasCatalog && scroller.current !== null) {
      scroller.current.scrollLeft = GUIDE_PAST_HOURS * 60 * PX_PER_MINUTE;
    }
  }, [hasCatalog]);

  useEffect(() => {
    if (selected === null) return;
    requestAnimationFrame(() => focusDefault());
    // « Retour » ferme d'abord la fiche (écoute en capture : avant la navigation globale).
    const onKey = (event: KeyboardEvent): void => {
      if (actionForKey(event.key) !== 'back') return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [selected]);

  if (!portalsLoading && portal === null) return <NoPortal />;
  if (catalog === null)
    return <div className="empty">{loading ? 'Chargement du guide…' : 'Guide indisponible.'}</div>;

  const ticks: number[] = [];
  for (let t = win.start; t < win.end; t += GUIDE_STEP_MS) ticks.push(t);
  const nowLeft = CHANNEL_COLUMN_PX + ((now - win.start) / 60_000) * PX_PER_MINUTE;

  return (
    <div className="live" style={{ gridTemplateColumns: 'var(--sidebar-width) 1fr' }}>
      <nav className="sidebar" aria-label="Genres">
        {[{ id: null as string | null, title: 'Toutes' }, ...catalog.genres].map((g) => (
          <button
            key={g.id ?? 'all'}
            type="button"
            className="genre"
            data-nav
            aria-pressed={genre === g.id}
            onClick={() => {
              navigate({ name: 'guide', genre: g.id }, { replace: true });
            }}
          >
            {g.title}
          </button>
        ))}
      </nav>
      <div ref={scroller} className="guide" data-testid="guide">
        <div
          style={{
            width: CHANNEL_COLUMN_PX + timelineWidth,
            height: virtualizer.getTotalSize() + RULER_HEIGHT_PX,
            position: 'relative',
          }}
        >
          <div className="guide-ruler" style={{ width: CHANNEL_COLUMN_PX + timelineWidth }}>
            <div className="guide-ruler-corner" />
            <div className="guide-timeline" style={{ width: timelineWidth }}>
              {ticks.map((t) => (
                <span
                  key={t}
                  className="guide-tick"
                  style={{ left: ((t - win.start) / 60_000) * PX_PER_MINUTE }}
                >
                  {formatTime(t)}
                </span>
              ))}
            </div>
          </div>
          <div className="guide-now" style={{ left: nowLeft }} aria-hidden="true" />
          {items.map((item) => {
            const channel = channels[item.index];
            if (channel === undefined) return null;
            const blocks = layoutProgrammes(epg(channel.id) ?? [], win, PX_PER_MINUTE, now);
            return (
              <div
                key={channel.id}
                className="guide-row"
                style={{
                  transform: `translateY(${item.start}px)`,
                  top: 0,
                  width: CHANNEL_COLUMN_PX + timelineWidth,
                }}
              >
                <div className="guide-channel">
                  <ChannelLogo src={channel.logo} name={channel.name} />
                  <span className="channel-name">{channel.name}</span>
                </div>
                <div className="guide-timeline" style={{ width: timelineWidth }}>
                  {blocks.length === 0 && (
                    <button
                      type="button"
                      className="programme"
                      data-nav
                      style={{ left: 0, width: timelineWidth }}
                      onClick={() => {
                        navigate({ name: 'watch', portalId: portalId ?? '', channelId: channel.id });
                      }}
                    >
                      {epg(channel.id) === undefined ? '…' : 'Programme non communiqué'}
                    </button>
                  )}
                  {blocks.map((b) => (
                    <button
                      key={b.entry.id}
                      type="button"
                      className={`programme${b.live ? ' live' : ''}`}
                      data-nav
                      {...(item.index === 0 && b.live ? { 'data-nav-default': true } : {})}
                      style={{ left: b.left, width: b.width }}
                      onClick={() => {
                        setSelected({ channel, entry: b.entry });
                      }}
                    >
                      {b.entry.title}
                      <small>
                        {formatTime(b.entry.start)} – {formatTime(b.entry.end)}
                      </small>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selected !== null && (
        <aside className="details" data-nav-scope role="dialog" aria-label={selected.entry.title}>
          <h3>{selected.entry.title}</h3>
          <div className="programme-now">
            {selected.channel.name} · {formatTime(selected.entry.start)} – {formatTime(selected.entry.end)}
          </div>
          {selected.entry.description !== '' && <p>{selected.entry.description}</p>}
          <div className="actions">
            {selected.entry.start <= now && now < selected.entry.end && (
              <button
                type="button"
                className="button primary"
                data-nav
                data-nav-default
                onClick={() => {
                  navigate({ name: 'watch', portalId: portalId ?? '', channelId: selected.channel.id });
                }}
              >
                ▶ Regarder
              </button>
            )}
            {/* Rattrapage : émission passée (ou commencée) que le portail garde dans son archive. */}
            {selected.entry.catchup && selected.entry.start <= now && (
              <button
                type="button"
                className={`button${now >= selected.entry.end ? ' primary' : ''}`}
                data-nav
                data-testid="catchup"
                {...(now >= selected.entry.end ? { 'data-nav-default': true } : {})}
                onClick={() => {
                  navigate({
                    name: 'play',
                    item: {
                      kind: 'archive',
                      portalId: portalId ?? '',
                      channelId: selected.channel.id,
                      start: selected.entry.start,
                      end: selected.entry.end,
                    },
                    startS: 0,
                  });
                }}
              >
                {now >= selected.entry.end ? '↺ Revoir' : '⏮ Depuis le début'}
              </button>
            )}
            <button
              type="button"
              className="button"
              data-nav
              {...(selected.entry.start > now || (now >= selected.entry.end && !selected.entry.catchup)
                ? { 'data-nav-default': true }
                : {})}
              onClick={() => {
                setSelected(null);
              }}
            >
              Fermer
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}

import type { ChannelDto, PlaybackStatusDto } from '@lumen/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { favoriteKey, useFavorites, useToggleFavorite } from '../api/queries.js';
import { useCatalog } from '../catalog/use-catalog.js';
import { ChannelLogo } from '../components/ChannelLogo.js';
import { useEpg } from '../epg/epg-store.js';
import { formatTime, nowNext } from '../epg/layout.js';
import { actionForKey } from '../nav/spatial.js';
import { focusDefault } from '../nav/use-dpad.js';
import { useHls } from '../player/use-hls.js';
import { usePlaybackSession } from '../player/use-playback-session.js';
import { goBack, navigate } from '../state/router.js';

/** Les commandes s'effacent après ce délai sans action : l'image d'abord. */
const OVERLAY_HIDE_MS = 4000;

function sourceLabel(status: PlaybackStatusDto | null): { text: string; warn: boolean } {
  if (status === null) return { text: 'Connexion…', warn: true };
  const source = status.sourceCount > 1 ? ` · source ${status.activeSource + 1}/${status.sourceCount}` : '';
  if (status.state === 'recovering') return { text: `Reprise en cours${source}`, warn: true };
  if (status.state === 'starting') return { text: `Démarrage${source}`, warn: true };
  return { text: `En direct${source}`, warn: status.activeSource > 0 };
}

/** Chaîne voisine dans la liste (genre de la chaîne en cours), en boucle. */
function neighbour(
  channels: readonly ChannelDto[],
  current: ChannelDto,
  step: 1 | -1,
): ChannelDto | undefined {
  const list = channels.filter((c) => c.genreId === current.genreId);
  const index = list.findIndex((c) => c.id === current.id);
  if (index < 0 || list.length < 2) return undefined;
  return list[(index + step + list.length) % list.length];
}

/** Lecture plein écran : image, commandes escamotables, zapping, indicateur de source. */
export function WatchScreen({ portalId, channelId }: { portalId: string; channelId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { catalog } = useCatalog(portalId);
  const channel = catalog?.byId.get(channelId);
  const session = usePlaybackSession(portalId, channelId);
  const streamUrl = session.state.kind === 'ready' ? session.state.playback.streamUrl : null;
  const player = useHls(videoRef, streamUrl, session.restart);
  const epg = useEpg(portalId, [channelId]);
  const programme = nowNext(epg(channelId) ?? [], Date.now());
  const favorites = useFavorites();
  const toggle = useToggleFavorite();
  const favorite = (favorites.data ?? []).some(
    (f) => favoriteKey(f.portalId, f.channelId) === favoriteKey(portalId, channelId),
  );

  const [overlay, setOverlay] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Commandes masquées : inertes, donc ni focalisables ni atteignables aux flèches.
  useEffect(() => {
    overlayRef.current?.toggleAttribute('inert', !overlay);
  }, [overlay]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showOverlay = useCallback(() => {
    setOverlay(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setOverlay(false);
    }, OVERLAY_HIDE_MS);
  }, []);
  useEffect(() => {
    showOverlay();
    return () => {
      clearTimeout(hideTimer.current);
    };
  }, [showOverlay, channelId]);

  const zap = useCallback(
    (step: 1 | -1) => {
      if (catalog === null || channel === undefined) return;
      const next = neighbour(catalog.channels, channel, step);
      // Remplacement : « retour » ramène à la liste, pas à la chaîne précédente.
      if (next !== undefined) navigate({ name: 'watch', portalId, channelId: next.id }, { replace: true });
    },
    [catalog, channel, portalId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = actionForKey(event.key);
      if (action === undefined) return;
      if (action === 'channelUp' || action === 'channelDown') {
        event.preventDefault();
        zap(action === 'channelUp' ? -1 : 1);
        return;
      }
      if (action === 'playPause') {
        event.preventDefault();
        const video = videoRef.current;
        if (video !== null) {
          if (video.paused) void video.play();
          else video.pause();
        }
        showOverlay();
        return;
      }
      if (!overlay && action !== 'back') {
        // Commandes masquées : haut/bas zappent, toute autre touche les fait apparaître.
        event.preventDefault();
        if (action === 'up' || action === 'down') zap(action === 'up' ? -1 : 1);
        showOverlay();
        requestAnimationFrame(() => focusDefault());
        return;
      }
      showOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [overlay, zap, showOverlay]);

  const source = sourceLabel(session.status);
  const title = channel === undefined ? 'Chaîne' : `${channel.number}. ${channel.name}`;

  return (
    <div className="player" onMouseMove={showOverlay} onClick={showOverlay} data-testid="player">
      <video ref={videoRef} playsInline aria-label={`Lecture : ${title}`} />
      {player.stalled && session.state.kind === 'ready' && (
        <div className="spinner" role="status" aria-label="Chargement" />
      )}
      {session.state.kind === 'starting' && <div className="spinner" role="status" aria-label="Démarrage" />}
      {session.state.kind === 'error' && (
        <div className="player-message" role="alert">
          <p>{session.state.message}</p>
          <button
            type="button"
            className="button primary"
            data-nav
            data-nav-default
            onClick={session.restart}
          >
            Réessayer maintenant
          </button>
        </div>
      )}
      {player.needsGesture && (
        <div className="player-message">
          <button
            type="button"
            className="button primary"
            data-nav
            data-nav-default
            onClick={() => void videoRef.current?.play()}
          >
            ▶ Lancer la lecture
          </button>
        </div>
      )}
      <div className={`overlay${overlay ? '' : ' hidden'}`} ref={overlayRef}>
        <div className="overlay-top">
          <button type="button" className="button" data-nav onClick={goBack} aria-label="Retour">
            ←
          </button>
          {channel !== undefined && <ChannelLogo src={channel.logo} name={channel.name} />}
          <div className="overlay-title">
            <strong>{title}</strong>
            <div>
              {programme.now === null
                ? 'Programme non communiqué'
                : `${formatTime(programme.now.start)} – ${formatTime(programme.now.end)} · ${programme.now.title}`}
            </div>
            {programme.next !== null && (
              <div>
                Ensuite, {formatTime(programme.next.start)} : {programme.next.title}
              </div>
            )}
          </div>
          <span className="source" data-testid="source-indicator">
            <span className={`dot${source.warn ? ' warn' : ''}`} />
            {source.text}
          </span>
        </div>
        <div className="overlay-bottom">
          <button
            type="button"
            className="button"
            data-nav
            onClick={() => {
              zap(-1);
            }}
          >
            ▲ Chaîne précédente
          </button>
          <button
            type="button"
            className="button"
            data-nav
            data-nav-default
            aria-pressed={favorite}
            onClick={() => {
              toggle.mutate({ portalId, channelId, on: !favorite });
            }}
          >
            {favorite ? '★ Favori' : '☆ Ajouter aux favoris'}
          </button>
          <button
            type="button"
            className="button"
            data-nav
            onClick={() => {
              zap(1);
            }}
          >
            ▼ Chaîne suivante
          </button>
          <span className="spacer" />
          {player.latencyS !== null && Number.isFinite(player.latencyS) && (
            <span
              className="source"
              title="Retard sur le direct : il protège la lecture des coupures du serveur"
            >
              Direct −{Math.round(player.latencyS)} s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

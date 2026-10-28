import { ALL_PORTALS_ID, type ChannelDto, type PlaybackStatusDto } from '@lumen/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { favoriteKey, useFavorites, usePortals, useToggleFavorite } from '../api/queries.js';
import { useCatalog } from '../catalog/use-catalog.js';
import { ChannelLogo } from '../components/ChannelLogo.js';
import { useEpg } from '../epg/epg-store.js';
import { formatTime, nowNext } from '../epg/layout.js';
import { actionForKey } from '../nav/spatial.js';
import { focusDefault } from '../nav/use-dpad.js';
import { dataUsage, formatBytes } from '../player/data-usage.js';
import { QUALITY_LABEL, QualityController, capFor } from '../player/quality.js';
import { type PlaybackStats, useHls } from '../player/use-hls.js';
import { useNetwork } from '../player/use-network.js';
import { request } from '../api/client.js';
import { usePlaybackSession } from '../player/use-playback-session.js';
import { usePrefs } from '../state/prefs.js';
import { goBack, navigate } from '../state/router.js';

/** Rythme du contrôle automatique de la qualité (débit mesuré, arrêts d'image). */
const QUALITY_TICK_MS = 5000;

/** Les commandes s'effacent après ce délai sans action : l'image d'abord. */
const OVERLAY_HIDE_MS = 4000;

/**
 * Indicateur de source et de santé. Quand l'image vient d'un autre portail que celui
 * choisi (bascule automatique), il le nomme : le spectateur comprend ce qui se passe.
 * Dans la vue « Tous les portails », aucun portail n'est choisi : il nomme celui qui sert.
 */
function sourceLabel(
  status: PlaybackStatusDto | null,
  requestedPortalId: string,
  portalName: (id: string) => string,
): { text: string; warn: boolean } {
  if (status === null) return { text: 'Connexion…', warn: true };
  const merged = requestedPortalId === ALL_PORTALS_ID;
  const elsewhere = !merged && status.activePortalId !== requestedPortalId;
  const ready =
    status.sourceCount > 1
      ? ` · ${status.sourceCount - 1} secours prêt${status.sourceCount > 2 ? 's' : ''}`
      : '';
  const source = elsewhere
    ? ` · secours : ${portalName(status.activePortalId)}`
    : merged
      ? ` · ${portalName(status.activePortalId)}${ready}`
      : ready;
  // Conversion pour ce navigateur : signalée, et précisée si le processeur du serveur s'en charge.
  const converted =
    status.transcode === null
      ? ''
      : status.transcode.video === 'copy'
        ? ' · son converti'
        : status.transcode.hardware
          ? ' · image convertie'
          : ' · image convertie (qualité réduite)';
  if (status.state === 'recovering') return { text: `Reprise en cours${source}`, warn: true };
  if (status.state === 'starting') return { text: `Démarrage${source}`, warn: true };
  return { text: `En direct${source}${converted}`, warn: elsewhere };
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
  // « Direct au plus près » mémorisé par chaîne sur cet appareil (le match en direct, le reste en confort).
  const channelKey = `${portalId}:${channelId}`;
  const lowLatency = usePrefs((s) => s.lowLatency.includes(channelKey));
  const toggleLowLatency = usePrefs((s) => s.toggleLowLatency);
  // Qualité : plafond du réseau (WiFi, données mobiles, économie de données), puis contrôle
  // automatique selon le débit réel ; les changements se font sans coupure.
  const network = useNetwork();
  const qualityPrefs = usePrefs((s) => s.quality);
  const cap = capFor(network, qualityPrefs);
  const session = usePlaybackSession(portalId, channelId, lowLatency, cap);
  const streamUrl = session.state.kind === 'ready' ? session.state.playback.streamUrl : null;
  const sessionId = session.state.kind === 'ready' ? session.state.playback.sessionId : null;
  const reportStats = useCallback(
    (stats: PlaybackStats) => {
      if (sessionId === null) return;
      // Ratio de rebuffering côté serveur : sans réponse attendue, sans nouvel essai.
      void request(`/api/playback/${encodeURIComponent(sessionId)}/stats`, {
        method: 'POST',
        body: stats,
      }).catch(() => undefined);
    },
    [sessionId],
  );
  const player = useHls(
    videoRef,
    streamUrl,
    session.restart,
    reportStats,
    lowLatency,
    network.slow || network.saveData || qualityPrefs.dataSaver,
  );
  const latest = useRef({ status: session.status, cap });
  latest.current = { status: session.status, cap };
  const controller = useRef(new QualityController());
  const { setQuality } = session;
  const { telemetry } = player;
  useEffect(() => {
    const timer = setInterval(() => {
      const { status: s, cap: c } = latest.current;
      if (s === null) return;
      const current = s.quality.requested;
      const next = controller.current.decide(
        { now: Date.now(), bandwidthBps: telemetry.bandwidthBps(), stalled: telemetry.takeStall() },
        current,
        c,
      );
      // Refus (conversions saturées) : la qualité actuelle reste, nouvel essai au prochain tour.
      if (next !== current) void setQuality(next).catch(() => undefined);
    }, QUALITY_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [setQuality, telemetry]);
  const epg = useEpg(portalId, [channelId]);
  const programme = nowNext(epg(channelId) ?? [], Date.now());
  const favorites = useFavorites();
  const portals = usePortals();
  const toggle = useToggleFavorite();
  // Chaîne fusionnée : favorite si l'une de ses sources l'est.
  const favorite = (favorites.data ?? []).some((f) =>
    catalog === null
      ? favoriteKey(f.portalId, f.channelId) === favoriteKey(portalId, channelId)
      : catalog.resolve(f)?.id === channelId,
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

  const source = sourceLabel(
    session.status,
    portalId,
    (id) => portals.data?.find((p) => p.id === id)?.name ?? 'autre portail',
  );
  const title = channel === undefined ? 'Chaîne' : `${channel.number}. ${channel.name}`;

  return (
    <div
      className="player"
      onMouseMove={showOverlay}
      onClick={showOverlay}
      data-testid="player"
      // Identifiant de la session de lecture : diagnostic et tests de chaos (rien de secret).
      data-session={session.state.kind === 'ready' ? session.state.playback.sessionId : undefined}
    >
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
              toggle.mutate({ portalId, channelId, on: !favorite, sources: channel?.sources ?? [] });
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
          <button
            type="button"
            className={`button${lowLatency ? ' primary' : ''}`}
            data-nav
            aria-pressed={lowLatency}
            title={
              lowLatency
                ? 'Quelques secondes du direct : une coupure du serveur se verrait aussitôt'
                : '20 s de retard qui absorbent les coupures du serveur'
            }
            onClick={() => {
              toggleLowLatency(channelKey);
            }}
          >
            ⚡ Direct au plus près
          </button>
          <span className="spacer" />
          {session.status !== null && (
            <span
              className="source"
              data-testid="quality-indicator"
              title="Qualité servie, et données consommées par cet appareil ce mois-ci"
            >
              {QUALITY_LABEL[session.status.quality.active]} · {formatBytes(dataUsage.bytes())} ce mois-ci
            </span>
          )}
          {player.latencyS !== null && Number.isFinite(player.latencyS) && (
            <span
              className="source"
              data-testid="live-latency"
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

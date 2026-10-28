import type { ProgressUpdateRequest, VodItemRef } from '@lumen/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  episodesQuery,
  findProgress,
  saveProgress,
  useEpisodes,
  useMovieDetail,
  useProgress,
  useSeriesDetail,
} from '../api/vod-queries.js';
import { actionForKey } from '../nav/spatial.js';
import { focusDefault } from '../nav/use-dpad.js';
import { dataUsage, formatBytes } from '../player/data-usage.js';
import { QUALITY_LABEL, capFor } from '../player/quality.js';
import { useNetwork } from '../player/use-network.js';
import { useVodPlayer } from '../player/use-vod-player.js';
import { episodeLabel, formatClock, nextEpisode } from '../player/vod-timeline.js';
import { usePrefs } from '../state/prefs.js';
import { goBack, navigate } from '../state/router.js';

/** Commandes masquées après ce délai sans geste (sauf en pause). */
const OVERLAY_HIDE_MS = 4000;
/** Flèches gauche/droite : 10 s en arrière ou en avant ; le bouton d'avance rapide en saute 30. */
const SEEK_STEP_S = 10;
const SEEK_LONG_S = 30;
/** Position enregistrée à ce rythme pendant la lecture (et à chaque pause, et en quittant). */
const PROGRESS_SAVE_MS = 10_000;
/** En deçà, rien à reprendre : le titre a juste été ouvert. */
const MIN_SAVED_POSITION_S = 5;
/** Reprise quelques secondes avant l'arrêt : le spectateur retrouve le fil. */
const RESUME_REWIND_S = 5;
/** Attente au plus de la position enregistrée par le serveur avant de démarrer. */
const RESUME_WAIT_MS = 1500;
/** Épisode suivant lancé seul après ce compte à rebours (annulable). */
const NEXT_EPISODE_DELAY_S = 10;
const MS_PER_S = 1000;

const itemIdOf = (item: VodItemRef): string => (item.kind === 'movie' ? item.movieId : item.episodeId);

/** Point de départ : celui demandé, sinon la reprise enregistrée (si le titre n'est pas fini). */
function useStartPosition(item: VodItemRef, requested: number | null): number | null {
  const progress = useProgress();
  const [start, setStart] = useState<number | null>(requested);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setWaited(true);
    }, RESUME_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (start !== null) return;
    // La copie du serveur peut être plus récente (autre appareil) : attendue un court instant,
    // puis la copie locale fait foi (hors ligne compris). On décide une seule fois.
    if (progress.isFetching && !waited) return;
    const saved = findProgress(progress.data, item.kind, item.portalId, itemIdOf(item));
    setStart(saved === undefined || saved.finished ? 0 : Math.max(0, saved.positionS - RESUME_REWIND_S));
  }, [start, progress.data, progress.isFetching, waited, item]);
  return start;
}

export function PlayScreen({ item, startS }: { item: VodItemRef; startS: number | null }) {
  const start = useStartPosition(item, startS);
  if (start === null) return <div className="player" data-testid="vod-player" />;
  return <VodPlayerView item={item} startS={start} />;
}

function VodPlayerView({ item, startS }: { item: VodItemRef; startS: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const client = useQueryClient();
  const network = useNetwork();
  const qualityPrefs = usePrefs((s) => s.quality);
  const player = useVodPlayer(videoRef, item, startS, capFor(network, qualityPrefs));
  const { state } = player;

  const isEpisode = item.kind === 'episode';
  const seriesId = isEpisode ? item.seriesId : '';
  const seasonId = isEpisode ? item.seasonId : null;
  const movie = useMovieDetail(item.portalId, item.kind === 'movie' ? item.movieId : '', !isEpisode);
  const series = useSeriesDetail(item.portalId, seriesId, isEpisode);
  const episodes = useEpisodes(item.portalId, seriesId, seasonId);
  const season = series.data?.seasons.find((s) => s.id === seasonId);
  const episode = isEpisode ? episodes.data?.find((ep) => ep.id === item.episodeId) : undefined;
  const label =
    season !== undefined && episode !== undefined
      ? episodeLabel(season.number, episode.number, episode.name)
      : null;
  const title = isEpisode ? (series.data?.name ?? 'Épisode') : (movie.data?.name ?? 'Film');

  // --- Position enregistrée : reprise sur tous les appareils du compte ---
  const stateRef = useRef(state);
  stateRef.current = state;
  const labelRef = useRef(label);
  labelRef.current = label;
  const save = useCallback(
    (keepalive: boolean) => {
      const s = stateRef.current;
      if (s.durationS === null || s.positionS < MIN_SAVED_POSITION_S) return;
      const update: ProgressUpdateRequest = {
        kind: item.kind,
        portalId: item.portalId,
        itemId: itemIdOf(item),
        seriesId: item.kind === 'episode' ? item.seriesId : null,
        seasonId: item.kind === 'episode' ? item.seasonId : null,
        positionS: s.ended ? s.durationS : s.positionS,
        durationS: s.durationS,
        label: labelRef.current,
      };
      saveProgress(client, update, keepalive).catch(() => undefined);
    },
    [client, item],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (!stateRef.current.paused) save(false);
    }, PROGRESS_SAVE_MS);
    return () => {
      clearInterval(timer);
      save(true);
    };
  }, [save]);
  useEffect(() => {
    if (state.paused || state.ended) save(false);
  }, [state.paused, state.ended, save]);

  // --- Épisode suivant ---
  const [next, setNext] = useState<{ seasonId: string; episodeId: string } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!state.ended || item.kind !== 'episode' || series.data === undefined || episodes.data === undefined)
      return;
    const found = nextEpisode(series.data.seasons, item.seasonId, episodes.data, item.episodeId);
    if (found === null) return;
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      let episodeId = found.episodeId;
      if (episodeId === null) {
        const list = await client.query(episodesQuery(item.portalId, item.seriesId, found.seasonId));
        episodeId = list[0]?.id ?? null;
      }
      if (cancelled || episodeId === null) return;
      setNext({ seasonId: found.seasonId, episodeId });
      setCountdown(NEXT_EPISODE_DELAY_S);
    };
    resolve().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state.ended, item, series.data, episodes.data, client]);
  const playNext = useCallback(() => {
    if (next === null || item.kind !== 'episode') return;
    setCountdown(null);
    navigate(
      {
        name: 'play',
        item: { ...item, seasonId: next.seasonId, episodeId: next.episodeId },
        startS: 0,
      },
      { replace: true },
    );
  }, [next, item]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      playNext();
      return;
    }
    const timer = setTimeout(() => {
      setCountdown((c) => (c === null ? null : c - 1));
    }, MS_PER_S);
    return () => {
      clearTimeout(timer);
    };
  }, [countdown, playNext]);

  // --- Commandes escamotables ---
  const [overlay, setOverlay] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showOverlay = useCallback(() => {
    setOverlay(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // En pause, les commandes restent : on regarde où l'on en est.
      if (!(videoRef.current?.paused ?? false)) setOverlay(false);
    }, OVERLAY_HIDE_MS);
  }, []);
  useEffect(() => {
    showOverlay();
    return () => {
      clearTimeout(hideTimer.current);
    };
  }, [showOverlay]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const action = actionForKey(event.key);
      if (action === undefined) return;
      if (action === 'playPause') {
        event.preventDefault();
        player.togglePlay();
        showOverlay();
        return;
      }
      if (!overlay && action !== 'back') {
        // Commandes masquées : gauche/droite déplacent dans le film, OK met en pause.
        event.preventDefault();
        if (action === 'left' || action === 'right')
          player.seekBy(action === 'left' ? -SEEK_STEP_S : SEEK_STEP_S);
        else if (action === 'select') player.togglePlay();
        showOverlay();
        if (action === 'up' || action === 'down') requestAnimationFrame(() => focusDefault());
        return;
      }
      showOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [overlay, player, showOverlay]);

  const duration = state.durationS;
  const ratio = (s: number): string =>
    duration === null || duration <= 0 ? '0%' : `${Math.min(100, (100 * s) / duration).toFixed(2)}%`;
  const seekTo = (event: MouseEvent<HTMLDivElement>): void => {
    if (duration === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    player.seek(((event.clientX - rect.left) / rect.width) * duration);
  };
  const track = state.audioTracks.find((t) => t.index === state.audioTrack);

  return (
    <div
      className="player"
      onMouseMove={showOverlay}
      onClick={showOverlay}
      data-testid="vod-player"
      data-position={state.positionS.toFixed(1)}
      data-phase={state.phase}
    >
      <video ref={videoRef} playsInline aria-label={`Lecture : ${title}`} />
      {(state.phase === 'starting' || (state.waiting && state.phase === 'ready')) && (
        <div className="spinner" role="status" aria-label="Chargement" />
      )}
      {state.phase === 'error' && (
        <div className="player-message" role="alert">
          <p>{state.message}</p>
          <button type="button" className="button primary" data-nav data-nav-default onClick={player.retry}>
            Réessayer maintenant
          </button>
        </div>
      )}
      {state.needsGesture && (
        <div className="player-message">
          <button
            type="button"
            className="button primary"
            data-nav
            data-nav-default
            onClick={player.togglePlay}
          >
            ▶ Lancer la lecture
          </button>
        </div>
      )}
      {next !== null && countdown !== null && (
        <div className="player-message" data-testid="next-episode" data-nav-scope>
          <p>Épisode suivant dans {countdown} s</p>
          <div className="actions">
            <button type="button" className="button primary" data-nav data-nav-default onClick={playNext}>
              ▶ Lire maintenant
            </button>
            <button
              type="button"
              className="button"
              data-nav
              onClick={() => {
                setCountdown(null);
                setNext(null);
              }}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
      <div className={`overlay${overlay ? '' : ' hidden'}`}>
        <div className="overlay-top">
          <button type="button" className="button" data-nav onClick={goBack} aria-label="Retour">
            ←
          </button>
          <div className="overlay-title">
            <strong>{title}</strong>
            {label !== null && <div>{label}</div>}
          </div>
          {state.quality !== null && (
            <span
              className="source"
              data-testid="quality-indicator"
              title="Qualité servie, et données consommées par cet appareil ce mois-ci"
            >
              {QUALITY_LABEL[state.quality]}
              {state.transcode?.video === true ? ' · image convertie' : ''} · {formatBytes(dataUsage.bytes())}{' '}
              ce mois-ci
            </span>
          )}
        </div>
        <div className="overlay-bottom vod-controls">
          <div
            className="seekbar"
            role="slider"
            tabIndex={0}
            data-nav
            data-testid="vod-seekbar"
            aria-label="Position dans le titre"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration ?? 0)}
            aria-valuenow={Math.round(state.positionS)}
            aria-valuetext={formatClock(state.positionS)}
            onClick={seekTo}
            onKeyDown={(event) => {
              const action = actionForKey(event.key);
              if (action !== 'left' && action !== 'right') return;
              // Sur la barre, gauche/droite déplacent dans le film au lieu de changer de bouton.
              event.preventDefault();
              player.seekBy(action === 'left' ? -SEEK_STEP_S : SEEK_STEP_S);
              showOverlay();
            }}
          >
            <span className="seekbar-buffered" style={{ width: ratio(state.bufferedS) }} />
            <span className="seekbar-played" style={{ width: ratio(state.positionS) }} />
          </div>
          <div className="vod-buttons">
            <button
              type="button"
              className="button"
              data-nav
              aria-label={`Reculer de ${SEEK_STEP_S} secondes`}
              onClick={() => {
                player.seekBy(-SEEK_STEP_S);
              }}
            >
              ⟲ {SEEK_STEP_S} s
            </button>
            <button
              type="button"
              className="button primary"
              data-nav
              data-nav-default
              data-testid="vod-play-pause"
              onClick={player.togglePlay}
            >
              {state.paused ? '▶ Lecture' : '❚❚ Pause'}
            </button>
            <button
              type="button"
              className="button"
              data-nav
              aria-label={`Avancer de ${SEEK_LONG_S} secondes`}
              onClick={() => {
                player.seekBy(SEEK_LONG_S);
              }}
            >
              {SEEK_LONG_S} s ⟳
            </button>
            {state.audioTracks.length > 1 && (
              <button
                type="button"
                className="button"
                data-nav
                data-testid="vod-audio"
                title="Changer de langue"
                onClick={() => {
                  const i = state.audioTracks.findIndex((t) => t.index === state.audioTrack);
                  const nextTrack = state.audioTracks[(i + 1) % state.audioTracks.length];
                  if (nextTrack !== undefined) player.setAudioTrack(nextTrack.index);
                }}
              >
                🔊 {track?.label ?? 'Piste audio'}
              </button>
            )}
            <span className="spacer" />
            <span className="vod-clock" data-testid="vod-clock">
              {formatClock(state.positionS)}
              {duration === null ? '' : ` / ${formatClock(duration)}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

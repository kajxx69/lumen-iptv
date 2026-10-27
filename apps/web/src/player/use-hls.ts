import Hls, { type ErrorData } from 'hls.js';
import { type RefObject, useEffect, useState } from 'react';
import { liveRate } from './live-delay.js';

/** Fréquence d'ajustement de la vitesse de lecture (retard sur le direct). */
const LIVE_DELAY_TICK_MS = 1000;
/** Un arrêt plus court que cela ne mérite pas d'indicateur de chargement (évite le clignotement). */
const SPINNER_DELAY_MS = 600;
/** Reprise après erreur réseau : 1 s, 2 s, 4 s… jusqu'à 8 s, sans fin tant que l'écran est ouvert. */
const NETWORK_RETRY_BASE_MS = 1000;
const NETWORK_RETRY_MAX_MS = 8000;
/** Au-delà de ce nombre de récupérations média ratées, le lecteur est recréé. */
const MEDIA_RECOVERY_ATTEMPTS = 2;

/**
 * Réglages hls.js pour un flux relayé par Lumen (segments de 2 s, tampon serveur de 30 s).
 * - Pas d'accélération pour rattraper le direct : le retard est voulu (voir live-delay).
 * - Latence maximale large : hls.js ne saute jamais en avant (ce serait une coupure).
 * - Tentatives de chargement nombreuses : le relais finit toujours par répondre.
 */
const HLS_CONFIG: Partial<Hls['config']> = {
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 60,
  maxLiveSyncPlaybackRate: 1,
  maxBufferLength: 30,
  backBufferLength: 30,
  enableWorker: true,
  lowLatencyMode: false,
  manifestLoadingMaxRetry: 6,
  levelLoadingMaxRetry: Infinity,
  fragLoadingMaxRetry: 8,
};

export interface HlsPlayerState {
  /** Image arrêtée faute de données depuis plus de SPINNER_DELAY_MS. */
  stalled: boolean;
  /** Le navigateur a refusé la lecture automatique : un geste de l'utilisateur est requis. */
  needsGesture: boolean;
  /** Retard actuel sur le direct (s). */
  latencyS: number | null;
}

const bufferAhead = (video: HTMLVideoElement): number => {
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= video.currentTime + 0.1 && video.currentTime < b.end(i))
      return b.end(i) - video.currentTime;
  }
  return 0;
};

/**
 * Lit la playlist du relais dans `videoRef`. Les erreurs réseau sont réessayées sans fin
 * (le relais reprend toujours) ; `onSessionLost` est appelé si la session n'existe plus
 * côté serveur (404 sur la playlist), pour en ouvrir une nouvelle.
 */
export function useHls(
  videoRef: RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
  onSessionLost: () => void,
): HlsPlayerState {
  const [stalled, setStalled] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [latencyS, setLatencyS] = useState<number | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || streamUrl === null) return;
    let disposed = false;
    let hls: Hls | null = null;
    let networkRetries = 0;
    let mediaRecoveries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let spinnerTimer: ReturnType<typeof setTimeout> | undefined;

    const play = (): void => {
      video.play().then(
        () => {
          setNeedsGesture(false);
        },
        (err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotAllowedError') setNeedsGesture(true);
        },
      );
    };

    const create = (): void => {
      hls?.destroy();
      if (!Hls.isSupported()) {
        // Safari iOS : HLS natif, sans MSE.
        video.src = streamUrl;
        play();
        return;
      }
      const instance = new Hls(HLS_CONFIG);
      hls = instance;
      instance.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (data.response?.code === 404 && data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
            onSessionLost();
            return;
          }
          const delay = Math.min(NETWORK_RETRY_MAX_MS, NETWORK_RETRY_BASE_MS * 2 ** networkRetries++);
          retryTimer = setTimeout(() => {
            if (!disposed) instance.startLoad();
          }, delay);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < MEDIA_RECOVERY_ATTEMPTS) {
          instance.recoverMediaError();
          return;
        }
        mediaRecoveries = 0;
        create();
      });
      instance.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
      });
      instance.attachMedia(video);
      instance.loadSource(streamUrl);
      play();
    };

    const onWaiting = (): void => {
      clearTimeout(spinnerTimer);
      spinnerTimer = setTimeout(() => {
        setStalled(true);
      }, SPINNER_DELAY_MS);
    };
    const onPlaying = (): void => {
      clearTimeout(spinnerTimer);
      setStalled(false);
    };
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onPlaying);

    // Retard sur le direct construit en douceur (lecture à 97 % tant qu'il manque).
    const tick = setInterval(() => {
      const latency = hls?.latency ?? null;
      setLatencyS(latency);
      const rate = liveRate({
        latencyS: latency !== null && Number.isFinite(latency) ? latency : null,
        bufferAheadS: bufferAhead(video),
        currentRate: video.playbackRate,
      });
      if (video.playbackRate !== rate) video.playbackRate = rate;
    }, LIVE_DELAY_TICK_MS);

    create();
    return () => {
      disposed = true;
      clearInterval(tick);
      clearTimeout(retryTimer);
      clearTimeout(spinnerTimer);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onPlaying);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [videoRef, streamUrl, onSessionLost]);

  return { stalled, needsGesture, latencyS };
}

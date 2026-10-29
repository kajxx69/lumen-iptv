import Hls, { type ErrorData } from 'hls.js';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  ADAPTIVE_BUFFER,
  ADAPTIVE_BUFFER_LOW_LATENCY,
  ADAPTIVE_BUFFER_UNSTABLE,
  AdaptiveBuffer,
} from './adaptive-buffer.js';
import { dataUsage } from './data-usage.js';
import { bufferedRanges, stallEscapeTarget } from './gap-jump.js';
import { LIVE_DELAY, liveRate } from './live-delay.js';

/** Fréquence d'ajustement de la vitesse de lecture (retard sur le direct). */
const LIVE_DELAY_TICK_MS = 1000;
/** Un arrêt plus court que cela ne mérite pas d'indicateur de chargement (évite le clignotement). */
const SPINNER_DELAY_MS = 600;
/** Reprise après erreur réseau : 1 s, 2 s, 4 s… jusqu'à 8 s, sans fin tant que l'écran est ouvert. */
const NETWORK_RETRY_BASE_MS = 1000;
const NETWORK_RETRY_MAX_MS = 8000;
/** Au-delà de ce nombre de récupérations média ratées, le lecteur est recréé. */
const MEDIA_RECOVERY_ATTEMPTS = 2;
/** Avance téléchargée au minimum, et marge au-delà du retard visé. */
const MIN_BUFFER_AHEAD_S = 30;
const BUFFER_MARGIN_S = 10;
/** Temps de lecture et d'attente remontés au serveur à ce rythme (ratio de rebuffering). */
const STATS_INTERVAL_MS = 30_000;
/** Surveillance des trous du tampon : une image immobile sur deux relevés suffit à agir. */
const GAP_CHECK_MS = 100;
const GAP_STUCK_CHECKS = 2;
/** Au-delà de ce retard seulement, hls.js revient au direct : bien plus que le tampon maximal (60 s). */
const MAX_LIVE_LATENCY_S = 120;
/**
 * « Direct au plus près » (LL-HLS) : 3 s derrière le direct, cible basse de PROJECT.md
 * (3–5 s), deux fois l'avance PART-HOLD-BACK du relais. Retard rattrapé en accélérant à
 * 105 % (imperceptible) ; au-delà de 15 s, hls.js revient au direct : le spectateur l'a voulu.
 */
const LOW_LATENCY_TARGET_S = 3;
const LOW_LATENCY_MAX_LATENCY_S = 15;
const LOW_LATENCY_CATCH_UP_RATE = 1.05;

export interface PlaybackStats {
  watchedMs: number;
  stalledMs: number;
}

/**
 * Réglages hls.js pour un flux relayé par Lumen (segments de 2 s, tampon serveur de 30 s).
 * - Position de départ : le retard visé (20 s, aussi annoncé par le relais en HOLD-BACK).
 *   Sur un relais déjà chaud, le lecteur part avec 20 s d'avance sur une panne ; sur un
 *   relais froid, il part du plus ancien segment disponible, puis le retard se construit.
 * - Pas d'accélération pour rattraper le direct : le retard est voulu.
 * - Latence maximale large : hls.js ne saute jamais en avant (ce serait une coupure).
 * - Tentatives de chargement nombreuses : le relais finit toujours par répondre.
 */
export const HLS_CONFIG: Partial<Hls['config']> = {
  liveSyncDuration: LIVE_DELAY.targetS,
  liveMaxLatencyDuration: MAX_LIVE_LATENCY_S,
  maxLiveSyncPlaybackRate: 1,
  maxBufferLength: 30,
  backBufferLength: 30,
  enableWorker: true,
  // Rechargement bloquant du relais (CAN-BLOCK-RELOAD) : hls.js ne l'utilise qu'en mode basse
  // latence. Chaque nouveau segment arrive à l'instant de sa publication, bascule comprise.
  lowLatencyMode: true,
  manifestLoadingMaxRetry: 6,
  levelLoadingMaxRetry: Infinity,
  fragLoadingMaxRetry: 8,
};

/** Réglages « direct au plus près » : parties de segment, cible 3 s, rattrapage doux. */
export const HLS_CONFIG_LOW_LATENCY: Partial<Hls['config']> = {
  ...HLS_CONFIG,
  liveSyncDuration: LOW_LATENCY_TARGET_S,
  liveMaxLatencyDuration: LOW_LATENCY_MAX_LATENCY_S,
  maxLiveSyncPlaybackRate: LOW_LATENCY_CATCH_UP_RATE,
};

/** Mesures du lecteur, lues par le contrôle automatique de la qualité. */
export interface HlsTelemetry {
  /** Débit estimé du réseau (bit/s), null s'il est encore inconnu. */
  bandwidthBps(): number | null;
  /** Une coupure de lecture depuis le dernier appel ? (remis à zéro à la lecture). */
  takeStall(): boolean;
}

export interface HlsPlayerState {
  /** Image arrêtée faute de données depuis plus de SPINNER_DELAY_MS. */
  stalled: boolean;
  /** Le navigateur a refusé la lecture automatique : un geste de l'utilisateur est requis. */
  needsGesture: boolean;
  /** Retard actuel sur le direct (s). */
  latencyS: number | null;
  telemetry: HlsTelemetry;
  /**
   * Début (temps de la vidéo) de ce que le serveur garde encore du direct, d'après la
   * dernière playlist : une image figée avant ce point n'est plus disponible. null : inconnu.
   */
  liveWindowStart: () => number | null;
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
  onStats?: (stats: PlaybackStats) => void,
  lowLatency = false,
  /** Réseau instable (2G/3G, économie de données) : tampon de départ renforcé. */
  unstableNetwork = false,
): HlsPlayerState {
  const [stalled, setStalled] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [latencyS, setLatencyS] = useState<number | null>(null);
  // Référence : le rappel peut changer à chaque rendu sans recréer le lecteur.
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  // Mesures partagées avec le contrôle de qualité : mises à jour sans rendu.
  const hlsRef = useRef<Hls | null>(null);
  const stallRef = useRef(false);
  const telemetry = useRef<HlsTelemetry>({
    bandwidthBps: () => {
      const estimate = hlsRef.current?.bandwidthEstimate;
      return estimate === undefined || !Number.isFinite(estimate) || estimate <= 0 ? null : estimate;
    },
    takeStall: () => {
      const stalled = stallRef.current;
      stallRef.current = false;
      return stalled;
    },
  }).current;

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || streamUrl === null) return;
    const buffer = new AdaptiveBuffer(
      lowLatency ? ADAPTIVE_BUFFER_LOW_LATENCY : unstableNetwork ? ADAPTIVE_BUFFER_UNSTABLE : ADAPTIVE_BUFFER,
    );
    let started = false;
    let watchedMs = 0;
    let lastReport = Date.now();
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
      const instance = new Hls(lowLatency ? HLS_CONFIG_LOW_LATENCY : HLS_CONFIG);
      hls = instance;
      hlsRef.current = instance;
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
        // Décodage impossible malgré les récupérations (format changé en cours de route) :
        // une nouvelle session, adaptée à ce navigateur, plutôt que la même playlist.
        mediaRecoveries = 0;
        onSessionLost();
      });
      instance.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        networkRetries = 0;
        // LL-HLS : l'événement porte la partie chargée ; sinon le segment entier.
        const loaded = data.part ?? data.frag;
        const loading = loaded.stats.loading;
        buffer.fragmentLoaded(Date.now(), (loading.end - loading.start) / 1000, loaded.duration);
        dataUsage.add(loaded.stats.loaded);
      });
      instance.attachMedia(video);
      instance.loadSource(streamUrl);
      play();
    };

    const onWaiting = (): void => {
      // Une attente après le démarrage est une coupure vue par le spectateur.
      if (started) {
        buffer.stalled(Date.now());
        stallRef.current = true;
      }
      clearTimeout(spinnerTimer);
      spinnerTimer = setTimeout(() => {
        setStalled(true);
      }, SPINNER_DELAY_MS);
    };
    const onPlaying = (): void => {
      if (video.currentTime > 0) started = true;
      buffer.resumed(Date.now());
      clearTimeout(spinnerTimer);
      setStalled(false);
    };
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onPlaying);
    // Retour de la connexion après une coupure totale : reprise tout de suite, sans attendre la
    // fin du délai de nouvel essai (PROJECT.md : « reprise automatique, sans intervention »).
    const onOnline = (): void => {
      clearTimeout(retryTimer);
      networkRetries = 0;
      hls?.startLoad();
    };
    window.addEventListener('online', onOnline);

    // Confort : retard sur le direct construit en douceur (lecture à 97 % tant qu'il manque),
    // vers une cible qui s'adapte à l'instabilité du réseau. Direct au plus près : hls.js
    // tient lui-même la cible (rattrapage à 105 %, cible allongée après un arrêt).
    const tick = setInterval(() => {
      const now = Date.now();
      const latency = hls?.latency ?? null;
      setLatencyS(latency);
      const targetS = buffer.targetS(now);
      if (!lowLatency) {
        const rate = liveRate(
          {
            latencyS: latency !== null && Number.isFinite(latency) ? latency : null,
            bufferAheadS: bufferAhead(video),
            currentRate: video.playbackRate,
          },
          { ...LIVE_DELAY, targetS },
        );
        if (video.playbackRate !== rate) video.playbackRate = rate;
      } else if (hls !== null) {
        // Cible LL-HLS pilotée elle aussi : 3 s, jusqu'à 8 s si le réseau peine (hls.js la relit).
        hls.config.liveSyncDuration = targetS;
      }
      // Téléchargement d'avance à la mesure du retard visé (pilotés, jamais figés : §6).
      if (hls !== null) hls.config.maxBufferLength = Math.max(MIN_BUFFER_AHEAD_S, targetS + BUFFER_MARGIN_S);
      if (started && !video.paused) watchedMs += LIVE_DELAY_TICK_MS;
      if (now - lastReport >= STATS_INTERVAL_MS) {
        lastReport = now;
        const stalledMs = buffer.takeStalledMs();
        if (watchedMs > 0 || stalledMs > 0) statsRef.current?.({ watchedMs, stalledMs });
        watchedMs = 0;
      }
    }, LIVE_DELAY_TICK_MS);

    // Image bloquée (changement de source) : débloquée dès qu'elle s'immobilise, voir gap-jump.
    let lastTime = -1;
    let stuckChecks = 0;
    const gapWatch = setInterval(() => {
      if (video.paused || video.seeking || video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        stuckChecks = 0;
        return;
      }
      if (++stuckChecks < GAP_STUCK_CHECKS) return;
      const target = stallEscapeTarget(bufferedRanges(video.buffered), video.currentTime);
      if (target !== null) {
        video.currentTime = target;
        stuckChecks = 0;
      }
    }, GAP_CHECK_MS);

    create();
    return () => {
      disposed = true;
      clearInterval(tick);
      clearInterval(gapWatch);
      clearTimeout(retryTimer);
      clearTimeout(spinnerTimer);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onPlaying);
      window.removeEventListener('online', onOnline);
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [videoRef, streamUrl, onSessionLost, lowLatency, unstableNetwork]);

  const liveWindowStart = useCallback((): number | null => {
    const details = hlsRef.current?.latestLevelDetails;
    return details?.live === true && details.fragments.length > 0 ? details.fragmentStart : null;
  }, []);

  return { stalled, needsGesture, latencyS, telemetry, liveWindowStart };
}

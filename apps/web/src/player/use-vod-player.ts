import {
  type QualityProfile,
  VOD_TIMELINE_EPOCH_MS,
  type VodAudioTrackDto,
  type VodSubtitleTrackDto,
  type VodItemRef,
  VodPlaybackDto,
} from '@lumen/protocol';
import Hls, { type ErrorData, type LevelLoadedData } from 'hls.js';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, request, requestJson } from '../api/client.js';
import { detectCapabilities } from './capabilities.js';
import { dataUsage } from './data-usage.js';
import { type PlaylistRange, endedEarly, seekPlan } from './vod-timeline.js';

/**
 * Réglages hls.js d'un film : départ au début de la playlist (sa vraie position est donnée
 * par EXT-X-PROGRAM-DATE-TIME), une minute d'avance téléchargée au plus (le serveur en
 * produit autant), pas de rattrapage de direct : un film n'en a pas.
 */
const VOD_HLS_CONFIG: Partial<Hls['config']> = {
  startPosition: 0,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  backBufferLength: 30,
  enableWorker: true,
  lowLatencyMode: false,
  manifestLoadingMaxRetry: 6,
  levelLoadingMaxRetry: Infinity,
  fragLoadingMaxRetry: 8,
};
/** Reprise après erreur réseau : 1 s, 2 s, 4 s… jusqu'à 8 s, sans fin tant que l'écran est ouvert. */
const NETWORK_RETRY_BASE_MS = 1000;
const NETWORK_RETRY_MAX_MS = 8000;
/** Au-delà de ce nombre de récupérations média ratées, la lecture repart sur une nouvelle session. */
const MEDIA_RECOVERY_ATTEMPTS = 2;
/** Démarrage refusé (portail lent, conversion saturée) : nouvel essai à ce rythme, en silence. */
const START_RETRY_MS = 5000;
/** Un arrêt plus court que cela ne mérite pas d'indicateur (évite le clignotement). */
const SPINNER_DELAY_MS = 600;

export interface VodPlayerState {
  phase: 'starting' | 'ready' | 'error';
  message: string | null;
  durationS: number | null;
  positionS: number;
  /** Fin de ce qui est chargé, en position dans le film. */
  bufferedS: number;
  paused: boolean;
  waiting: boolean;
  /** Fin réelle du titre atteinte. */
  ended: boolean;
  needsGesture: boolean;
  audioTracks: VodAudioTrackDto[];
  audioTrack: number;
  transcode: { video: boolean; audio: boolean } | null;
  quality: QualityProfile | null;
  /** Lecture en cours (relève des sous-titres) ; null avant le démarrage. */
  sessionId: string | null;
  subtitleTracks: VodSubtitleTrackDto[];
  /** Sous-titres en images incrustés ; null : aucun. */
  burnedSubtitle: number | null;
  /** Message du serveur pour le spectateur (incrustation refusée…). */
  notice: string | null;
}

const INITIAL: VodPlayerState = {
  phase: 'starting',
  message: null,
  durationS: null,
  positionS: 0,
  bufferedS: 0,
  paused: false,
  waiting: false,
  ended: false,
  needsGesture: false,
  audioTracks: [],
  audioTrack: 0,
  transcode: null,
  quality: null,
  sessionId: null,
  subtitleTracks: [],
  burnedSubtitle: null,
  notice: null,
};

export interface VodPlayer {
  state: VodPlayerState;
  togglePlay: () => void;
  seek: (positionS: number) => void;
  seekBy: (deltaS: number) => void;
  setAudioTrack: (index: number) => void;
  retry: () => void;
  /** Incruste ces sous-titres en images (null : plus aucun) ; la lecture repart au même endroit. */
  setBurnSubtitle: (index: number | null) => void;
  /** Position dans le titre à cet instant, lue sur la vidéo (pour l'affichage des répliques). */
  position: () => number;
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'too_many_streams':
        return 'Le serveur lit déjà le maximum de films. Nouvel essai automatique…';
      case 'transcode_busy':
        return 'Le serveur convertit déjà le maximum de flux. Nouvel essai automatique…';
      case 'unsupported_codec':
        return 'Ce navigateur ne lit pas le format de ce titre, et la conversion est désactivée.';
      case 'not_found':
        return 'Ce titre n’est plus proposé par le portail.';
      default:
        return `${err.message}. Nouvel essai automatique…`;
    }
  }
  return 'Serveur injoignable. Nouvel essai automatique…';
}

/** Erreurs définitives : réessayer n'y changerait rien. */
const isPermanent = (err: unknown): boolean =>
  err instanceof ApiError && (err.code === 'not_found' || err.code === 'unsupported_codec');

/**
 * Lecture d'un film ou d'un épisode. La position affichée est la vraie position dans le
 * titre, quel que soit le point de départ de la lecture en cours. Un saut dans ce qui est
 * déjà chargé est immédiat ; au-delà, une nouvelle lecture part de la position voulue et
 * remplace l'ancienne. Une lecture qui s'arrête avant la fin (fichier perdu en route)
 * reprend seule là où l'image s'est arrêtée.
 */
export function useVodPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  item: VodItemRef,
  initialStartS: number,
  quality: QualityProfile,
  options: { resumeEarlyEnd: boolean } = { resumeEarlyEnd: true },
): VodPlayer {
  const [state, setState] = useState<VodPlayerState>(INITIAL);
  const caps = useMemo(() => detectCapabilities(Hls.isSupported()), []);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<VodPlaybackDto | null>(null);
  /** Position dans le film = temps de la vidéo + décalage. */
  const offsetRef = useRef(initialStartS);
  const playlistRef = useRef<PlaylistRange | null>(null);
  const audioRef = useRef<number | undefined>(undefined);
  const burnRef = useRef<number | null>(null);
  const disposed = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Toujours la version courante de `reopen` : hls.js et les écouteurs vidéo la rappellent plus tard. */
  const reopenRef = useRef<(startS: number) => Promise<void>>(() => Promise.resolve());
  const resumeEarlyEnd = useRef(options.resumeEarlyEnd);
  resumeEarlyEnd.current = options.resumeEarlyEnd;
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const itemKey = JSON.stringify(item);

  const position = useCallback((): number => {
    const video = videoRef.current;
    return video === null ? offsetRef.current : video.currentTime + offsetRef.current;
  }, [videoRef]);

  const attach = useCallback(
    (dto: VodPlaybackDto) => {
      const video = videoRef.current;
      if (video === null) return;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      offsetRef.current = dto.startS;
      playlistRef.current = null;
      const play = (): void => {
        video.play().then(
          () => {
            setState((s) => ({ ...s, needsGesture: false }));
          },
          (err: unknown) => {
            // Lecture automatique refusée par le navigateur : un geste du spectateur suffit.
            if (err instanceof DOMException && err.name === 'NotAllowedError') {
              setState((s) => ({ ...s, needsGesture: true }));
            }
          },
        );
      };
      if (!Hls.isSupported()) {
        // Safari (iPhone) : HLS natif.
        video.src = dto.playlistUrl;
        play();
        return;
      }
      const hls = new Hls(VOD_HLS_CONFIG);
      hlsRef.current = hls;
      let networkRetries = 0;
      let mediaRecoveries = 0;
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data: LevelLoadedData) => {
        const frags = data.details.fragments;
        const first = frags[0];
        const last = frags[frags.length - 1];
        if (first?.programDateTime != null) {
          offsetRef.current = (first.programDateTime - VOD_TIMELINE_EPOCH_MS) / 1000 - first.start;
        }
        if (first !== undefined && last !== undefined) {
          playlistRef.current = { start: first.start, end: last.start + last.duration };
        }
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        networkRetries = 0;
        dataUsage.add(data.frag.stats.loaded);
      });
      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Lecture fermée par le serveur (inactivité, redémarrage) : une nouvelle, au même endroit.
          if (data.response?.code === 404) {
            void reopenRef.current(position());
            return;
          }
          const delay = Math.min(NETWORK_RETRY_MAX_MS, NETWORK_RETRY_BASE_MS * 2 ** networkRetries++);
          retryTimer.current = setTimeout(() => {
            if (!disposed.current) hls.startLoad();
          }, delay);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < MEDIA_RECOVERY_ATTEMPTS) {
          hls.recoverMediaError();
          return;
        }
        void reopenRef.current(position());
      });
      hls.on(Hls.Events.MANIFEST_PARSED, play);
      hls.attachMedia(video);
      hls.loadSource(dto.playlistUrl);
    },
    [videoRef, position],
  );

  /** Nouvelle lecture à `startS`, qui remplace la précédente. */
  const reopen = useCallback(
    async (startS: number): Promise<void> => {
      clearTimeout(retryTimer.current);
      setState((s) => ({ ...s, phase: 'starting', message: null, ended: false, positionS: startS }));
      const previous = sessionRef.current;
      try {
        const dto = await requestJson(VodPlaybackDto, '/api/vod/sessions', {
          method: 'POST',
          body: {
            item: JSON.parse(itemKey) as VodItemRef,
            startS,
            caps,
            quality: qualityRef.current,
            ...(audioRef.current === undefined ? {} : { audioTrack: audioRef.current }),
            ...(burnRef.current === null ? {} : { burnSubtitle: burnRef.current }),
            ...(previous === null ? {} : { replaces: previous.sessionId }),
          },
        });
        if (disposed.current) {
          void request(`/api/vod/sessions/${dto.sessionId}`, { method: 'DELETE', keepalive: true }).catch(
            () => undefined,
          );
          return;
        }
        sessionRef.current = dto;
        audioRef.current = dto.audioTrack;
        setState((s) => ({
          ...s,
          phase: 'ready',
          durationS: dto.durationS,
          audioTracks: dto.audioTracks,
          audioTrack: dto.audioTrack,
          transcode: dto.transcode,
          quality: dto.quality,
          sessionId: dto.sessionId,
          subtitleTracks: dto.subtitleTracks,
          burnedSubtitle: dto.burnedSubtitle,
          notice: dto.notice,
        }));
        attach(dto);
      } catch (err) {
        if (disposed.current) return;
        sessionRef.current = null;
        setState((s) => ({ ...s, phase: 'error', message: messageFor(err) }));
        if (!isPermanent(err)) {
          retryTimer.current = setTimeout(() => {
            if (!disposed.current) void reopen(startS);
          }, START_RETRY_MS);
        }
      }
    },
    [attach, caps, itemKey],
  );
  reopenRef.current = reopen;

  // Ouverture, et fermeture de la lecture en quittant l'écran.
  useEffect(() => {
    disposed.current = false;
    sessionRef.current = null;
    audioRef.current = undefined;
    burnRef.current = null;
    setState(INITIAL);
    void reopen(initialStartS);
    return () => {
      disposed.current = true;
      clearTimeout(retryTimer.current);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session !== null) {
        void request(`/api/vod/sessions/${session.sessionId}`, { method: 'DELETE', keepalive: true }).catch(
          () => undefined,
        );
      }
    };
    // Un autre titre (épisode suivant) : nouvelle lecture ; la position de départ ne compte qu'à l'ouverture.
  }, [itemKey]);

  // État de l'image : position, chargé, pause, attente, fin.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let spinner: ReturnType<typeof setTimeout> | undefined;
    const update = (): void => {
      const now = video.currentTime;
      let bufferedEnd = now;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= now + 0.5 && video.buffered.end(i) >= now)
          bufferedEnd = video.buffered.end(i);
      }
      setState((s) => ({
        ...s,
        positionS: now + offsetRef.current,
        bufferedS: bufferedEnd + offsetRef.current,
        paused: video.paused,
      }));
    };
    const waiting = (): void => {
      clearTimeout(spinner);
      spinner = setTimeout(() => {
        setState((s) => ({ ...s, waiting: true }));
      }, SPINNER_DELAY_MS);
    };
    const playing = (): void => {
      clearTimeout(spinner);
      setState((s) => ({ ...s, waiting: false }));
    };
    const ended = (): void => {
      const pos = position();
      if (resumeEarlyEnd.current && endedEarly(pos, sessionRef.current?.durationS ?? null)) {
        void reopenRef.current(pos);
        return;
      }
      setState((s) => ({ ...s, ended: true, paused: true }));
    };
    const events: [string, () => void][] = [
      ['timeupdate', update],
      ['progress', update],
      ['pause', update],
      ['play', update],
      ['seeked', update],
      ['waiting', waiting],
      ['playing', playing],
      ['ended', ended],
    ];
    for (const [name, fn] of events) video.addEventListener(name, fn);
    return () => {
      clearTimeout(spinner);
      for (const [name, fn] of events) video.removeEventListener(name, fn);
    };
  }, [videoRef, position]);

  const seek = useCallback(
    (targetS: number) => {
      const video = videoRef.current;
      if (video === null) return;
      const duration = sessionRef.current?.durationS ?? null;
      const target = Math.max(0, duration === null ? targetS : Math.min(targetS, duration - 1));
      const buffered: [number, number][] = [];
      for (let i = 0; i < video.buffered.length; i++)
        buffered.push([video.buffered.start(i), video.buffered.end(i)]);
      const plan = seekPlan(target, {
        offsetS: offsetRef.current,
        currentTime: video.currentTime,
        buffered,
        playlist: playlistRef.current,
      });
      setState((s) => ({ ...s, positionS: target, ended: false }));
      if (plan.kind === 'local') video.currentTime = plan.currentTime;
      else void reopen(plan.startS);
    },
    [videoRef, reopen],
  );

  return {
    state,
    togglePlay: () => {
      const video = videoRef.current;
      if (video === null) return;
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    },
    seek,
    seekBy: (deltaS: number) => {
      seek(position() + deltaS);
    },
    setAudioTrack: (index: number) => {
      if (index === audioRef.current) return;
      audioRef.current = index;
      // Autre piste : le serveur relit le fichier avec elle, à la position en cours.
      void reopen(position());
    },
    setBurnSubtitle: (index: number | null) => {
      if (index === burnRef.current) return;
      burnRef.current = index;
      void reopen(position());
    },
    position,
    retry: () => {
      void reopen(position());
    },
  };
}

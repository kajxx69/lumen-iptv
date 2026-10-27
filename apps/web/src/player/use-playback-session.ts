import { PlaybackDto, PlaybackStatusDto } from '@lumen/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, OfflineError, request, requestJson } from '../api/client.js';

/** Après un échec de démarrage, nouvelle tentative automatique : l'utilisateur n'a rien à faire. */
const START_RETRY_MS = 10_000;
/** Fréquence de lecture de l'état du relais (indicateur de source et de santé). */
const STATUS_POLL_MS = 5000;

export type SessionState =
  | { kind: 'starting' }
  | { kind: 'ready'; playback: PlaybackDto }
  | { kind: 'error'; message: string; retrying: boolean };

function stop(sessionId: string): void {
  // keepalive : l'arrêt part même si la page se ferme ; le serveur libère la connexion amont.
  void request(`/api/playback/${encodeURIComponent(sessionId)}`, { method: 'DELETE', keepalive: true }).catch(
    () => undefined,
  );
}

function describe(err: unknown): { message: string; retry: boolean } {
  if (err instanceof OfflineError)
    return { message: 'Connexion au serveur perdue. Reprise automatique…', retry: true };
  if (err instanceof ApiError) {
    if (err.code === 'too_many_streams') {
      return {
        message: 'Trop de lectures en cours sur ce compte. Fermez-en une, puis réessayez.',
        retry: false,
      };
    }
    if (err.code === 'not_found')
      return { message: 'Cette chaîne n’existe plus sur le portail.', retry: false };
    if (err.code === 'stream_unavailable') {
      return { message: 'La chaîne ne répond pas pour le moment. Nouvel essai automatique…', retry: true };
    }
    return { message: err.message, retry: true };
  }
  return { message: 'Lecture impossible.', retry: true };
}

/**
 * Session de lecture côté serveur pour une chaîne : ouverte au montage, fermée au départ,
 * rouverte automatiquement si elle disparaît (redémarrage du serveur) ou si le démarrage
 * échoue. Le lecteur n'affiche une erreur que si rien ne peut être tenté.
 */
export function usePlaybackSession(
  portalId: string,
  channelId: string,
): {
  state: SessionState;
  status: PlaybackStatusDto | null;
  /** À appeler quand le flux ne répond plus (session perdue) : une nouvelle session est ouverte. */
  restart: () => void;
} {
  const [state, setState] = useState<SessionState>({ kind: 'starting' });
  const [status, setStatus] = useState<PlaybackStatusDto | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: 'starting' });
    setStatus(null);
    requestJson(PlaybackDto, '/api/playback', { method: 'POST', body: { portalId, channelId } })
      .then((playback) => {
        if (cancelled) {
          stop(playback.sessionId);
          return;
        }
        sessionRef.current = playback.sessionId;
        setState({ kind: 'ready', playback });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const { message, retry } = describe(err);
        setState({ kind: 'error', message, retrying: retry });
        if (retry) {
          retryTimer = setTimeout(() => {
            setAttempt((a) => a + 1);
          }, START_RETRY_MS);
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (sessionRef.current !== null) stop(sessionRef.current);
      sessionRef.current = null;
    };
  }, [portalId, channelId, attempt]);

  // Fermeture de l'onglet : la session est libérée sans attendre son expiration.
  useEffect(() => {
    const onHide = (): void => {
      if (sessionRef.current !== null) stop(sessionRef.current);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  const sessionId = state.kind === 'ready' ? state.playback.sessionId : null;
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    const poll = (): void => {
      requestJson(PlaybackStatusDto, `/api/playback/${encodeURIComponent(sessionId)}/status`)
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  const restart = useCallback(() => {
    setAttempt((a) => a + 1);
  }, []);

  return { state, status, restart };
}

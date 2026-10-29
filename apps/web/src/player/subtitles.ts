import { type Cue, activeCue } from '@lumen/core/subtitles';
import { SubtitleCuesDto } from '@lumen/protocol';
import { useEffect, useState } from 'react';
import { requestJson } from '../api/client.js';

/**
 * Relève des répliques extraites par le serveur : elles arrivent avec la lecture du fichier,
 * bien avant d'être affichées (le serveur lit jusqu'à une minute d'avance).
 */
const CUES_POLL_MS = 2000;
/** Décalage des sous-titres réglable par pas d'une demi-seconde. */
export const SUBTITLE_DELAY_STEP_S = 0.5;

/** Répliques de la piste `index` de la lecture en cours ; [] sans piste choisie. */
export function useServerCues(sessionId: string | null, index: number | null): Cue[] {
  const [cues, setCues] = useState<Cue[]>([]);
  useEffect(() => {
    setCues([]);
    if (sessionId === null || index === null) return;
    let after = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const batch = await requestJson(
          SubtitleCuesDto,
          `/api/vod/sessions/${encodeURIComponent(sessionId)}/subtitles/${index}?after=${after}`,
        );
        if (stopped) return;
        after = batch.next;
        if (batch.cues.length > 0) {
          setCues((old) => [...old, ...batch.cues].sort((a, b) => a.startS - b.startS));
        }
        if (batch.complete) return;
      } catch {
        // Lecture remplacée ou réseau coupé : la relève continue, la lecture en cours dira le reste.
      }
      if (!stopped) timer = setTimeout(() => void poll(), CUES_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId, index]);
  return cues;
}

/**
 * Réplique à afficher, suivie image par image : `position` lit la vidéo à chaque trame, le
 * texte ne change à l'écran que lorsqu'il change vraiment.
 */
export function useActiveCueText(
  cues: readonly Cue[],
  position: () => number,
  delayS: number,
): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (cues.length === 0) {
      setText(null);
      return;
    }
    let frame = 0;
    let shown: string | null = null;
    const tick = (): void => {
      const next = activeCue(cues, position() - delayS)?.text ?? null;
      if (next !== shown) {
        shown = next;
        setText(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [cues, position, delayS]);
  return text;
}

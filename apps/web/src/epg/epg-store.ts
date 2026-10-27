import { EPG_BATCH_MAX_CHANNELS, EpgBatchDto, type EpgEntryDto } from '@lumen/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import { requestJson } from '../api/client.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Fenêtre chargée autour de maintenant : la liste (en cours, suivant) et 4 h de guide. */
const EPG_PAST_MS = 2 * HOUR_MS;
const EPG_FUTURE_MS = 6 * HOUR_MS;
/** Une grille chargée reste valable 15 min (au-delà, le « suivant » d'hier ne vaut plus rien). */
const EPG_FRESH_MS = 15 * MINUTE_MS;
/** Les lignes qui défilent sont regroupées avant d'interroger le serveur : une requête, pas cinquante. */
const BATCH_DELAY_MS = 120;
/** Après un échec, la chaîne n'est pas redemandée avant ce délai. */
const FAILURE_RETRY_MS = MINUTE_MS;

interface Slot {
  entries: EpgEntryDto[];
  fetchedAt: number;
}

const slots = new Map<string, Slot>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
const pending = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let snapshot = 0;

const slotKey = (portalId: string, channelId: string): string => `${portalId}:${channelId}`;

function notify(): void {
  snapshot++;
  for (const l of listeners) l();
}

function isFresh(key: string, now: number): boolean {
  const slot = slots.get(key);
  return slot !== undefined && now - slot.fetchedAt < EPG_FRESH_MS;
}

async function flush(): Promise<void> {
  timer = null;
  const batches = [...pending.entries()];
  pending.clear();
  for (const [portalId, ids] of batches) {
    const wanted = [...ids];
    for (let i = 0; i < wanted.length; i += EPG_BATCH_MAX_CHANNELS) {
      const chunk = wanted.slice(i, i + EPG_BATCH_MAX_CHANNELS);
      const now = Date.now();
      try {
        const data = await requestJson(
          EpgBatchDto,
          `/api/portals/${encodeURIComponent(portalId)}/epg?channels=${chunk.map(encodeURIComponent).join(',')}` +
            `&from=${now - EPG_PAST_MS}&to=${now + EPG_FUTURE_MS}`,
        );
        for (const id of chunk)
          slots.set(slotKey(portalId, id), { entries: data[id] ?? [], fetchedAt: Date.now() });
      } catch {
        // Grille indisponible : la liste s'affiche sans programme, on réessaiera plus tard.
        const retryAt = Date.now() - EPG_FRESH_MS + FAILURE_RETRY_MS;
        for (const id of chunk) {
          if (!slots.has(slotKey(portalId, id)))
            slots.set(slotKey(portalId, id), { entries: [], fetchedAt: retryAt });
        }
      } finally {
        for (const id of chunk) inFlight.delete(slotKey(portalId, id));
      }
      notify();
    }
  }
}

/** Demande la grille de ces chaînes ; celles déjà fraîches ou en cours de chargement sont ignorées. */
export function requestEpg(portalId: string, channelIds: readonly string[]): void {
  const now = Date.now();
  for (const id of channelIds) {
    const key = slotKey(portalId, id);
    if (isFresh(key, now) || inFlight.has(key)) continue;
    inFlight.add(key);
    let set = pending.get(portalId);
    if (set === undefined) pending.set(portalId, (set = new Set()));
    set.add(id);
  }
  if (pending.size > 0 && timer === null) {
    timer = setTimeout(() => {
      void flush();
    }, BATCH_DELAY_MS);
  }
}

export function epgOf(portalId: string, channelId: string): EpgEntryDto[] | undefined {
  return slots.get(slotKey(portalId, channelId))?.entries;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Grilles EPG des chaînes visibles. Renvoie une fonction de lecture (undefined tant que la
 * grille n'est pas arrivée) ; le composant se redessine quand de nouvelles grilles arrivent.
 */
export function useEpg(
  portalId: string | null,
  channelIds: readonly string[],
): (channelId: string) => EpgEntryDto[] | undefined {
  useSyncExternalStore(subscribe, () => snapshot);
  const idsKey = channelIds.join(',');
  useEffect(() => {
    if (portalId !== null && idsKey !== '') requestEpg(portalId, idsKey.split(','));
  }, [portalId, idsKey]);
  return (channelId) => (portalId === null ? undefined : epgOf(portalId, channelId));
}

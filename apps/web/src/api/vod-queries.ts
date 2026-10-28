import {
  EpisodeDto,
  MovieDetailDto,
  ProgressDto,
  type ProgressKind,
  type ProgressUpdateRequest,
  SeriesDetailDto,
  isFinished,
} from '@lumen/protocol';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request, requestJson } from './client.js';
import { persisted } from './queries.js';

/** Fiches, saisons et épisodes changent rarement : gardés 10 minutes sans redemander. */
const DETAIL_STALE_MS = 10 * 60_000;

const e = encodeURIComponent;

export function useMovieDetail(portalId: string, movieId: string, enabled = true) {
  return useQuery({
    queryKey: ['movie', portalId, movieId],
    queryFn: () => requestJson(MovieDetailDto, `/api/portals/${e(portalId)}/movies/${e(movieId)}`),
    staleTime: DETAIL_STALE_MS,
    enabled,
  });
}

export function useSeriesDetail(portalId: string, seriesId: string, enabled = true) {
  return useQuery({
    queryKey: ['series', portalId, seriesId],
    queryFn: () => requestJson(SeriesDetailDto, `/api/portals/${e(portalId)}/series/${e(seriesId)}`),
    staleTime: DETAIL_STALE_MS,
    enabled,
  });
}

export const episodesQuery = (portalId: string, seriesId: string, seasonId: string) => ({
  queryKey: ['episodes', portalId, seriesId, seasonId],
  queryFn: () =>
    requestJson(
      z.array(EpisodeDto),
      `/api/portals/${e(portalId)}/series/${e(seriesId)}/seasons/${e(seasonId)}`,
    ),
  staleTime: DETAIL_STALE_MS,
});

export function useEpisodes(portalId: string, seriesId: string, seasonId: string | null) {
  return useQuery({ ...episodesQuery(portalId, seriesId, seasonId ?? ''), enabled: seasonId !== null });
}

// --- Reprise de lecture ---

const progressCache = persisted('progress', z.array(ProgressDto));
export const progressKey = ['progress'];

/** Positions de lecture du compte, gardées sur l'appareil : « Reprendre » s'affiche hors ligne aussi. */
export function useProgress(enabled = true) {
  return useQuery({
    queryKey: progressKey,
    queryFn: async () => progressCache.save(await requestJson(z.array(ProgressDto), '/api/progress')),
    initialData: progressCache.initial,
    initialDataUpdatedAt: 0,
    enabled,
  });
}

export const findProgress = (
  list: readonly ProgressDto[] | undefined,
  kind: ProgressKind,
  portalId: string,
  itemId: string,
): ProgressDto | undefined =>
  list?.find((p) => p.kind === kind && p.portalId === portalId && p.itemId === itemId);

/**
 * Enregistre une position, à l'écran tout de suite (liste locale) puis sur le serveur.
 * `keepalive` : envoi qui part même si la page se ferme (fin de lecture).
 */
export async function saveProgress(
  client: QueryClient,
  update: ProgressUpdateRequest,
  keepalive = false,
): Promise<void> {
  const local: ProgressDto = {
    ...update,
    finished: isFinished(update.positionS, update.durationS),
    updatedAt: Date.now(),
  };
  client.setQueryData<ProgressDto[]>(progressKey, (old) => [
    local,
    ...(old ?? []).filter(
      (p) => !(p.kind === update.kind && p.portalId === update.portalId && p.itemId === update.itemId),
    ),
  ]);
  await request('/api/progress', { method: 'PUT', body: update, keepalive });
}

export async function removeProgress(
  client: QueryClient,
  kind: ProgressKind,
  portalId: string,
  itemId: string,
): Promise<void> {
  client.setQueryData<ProgressDto[]>(progressKey, (old) =>
    (old ?? []).filter((p) => !(p.kind === kind && p.portalId === portalId && p.itemId === itemId)),
  );
  await request(`/api/progress/${kind}/${e(portalId)}/${e(itemId)}`, { method: 'DELETE' });
}

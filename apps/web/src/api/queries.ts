import {
  type CreatePortalRequest,
  FavoriteDto,
  type LoginRequest,
  MeDto,
  type MergeOverrideRequest,
  MergeSettingsDto,
  PortalDto,
  PortalHealthDto,
  RecentDto,
} from '@lumen/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, request, requestJson } from './client.js';

/**
 * Dernière réponse gardée sur l'appareil pour les petites listes (portails, favoris,
 * récents) : hors ligne, l'application s'ouvre avec elles au lieu d'un écran vide.
 */
export function persisted<S extends z.ZodType>(key: string, schema: S) {
  const storageKey = `lumen.cache.${key}`;
  return {
    initial: (): z.output<S> | undefined => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw === null) return undefined;
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    save: (value: z.output<S>): z.output<S> => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        // Stockage plein ou refusé : seule l'ouverture hors ligne en pâtit.
      }
      return value;
    },
  };
}

const portalsCache = persisted('portals', z.array(PortalDto));
const favoritesCache = persisted('favorites', z.array(FavoriteDto));
const recentsCache = persisted('recents', z.array(RecentDto));

/** Effacé à la déconnexion : le compte suivant ne doit rien voir du précédent. */
function clearPersisted(): void {
  for (const key of ['portals', 'favorites', 'recents', 'progress']) {
    try {
      window.localStorage.removeItem(`lumen.cache.${key}`);
    } catch {
      // Rien à effacer.
    }
  }
}

/** Session courante ; `null` si personne n'est connecté. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await requestJson(MeDto, '/api/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: LoginRequest) => {
      await request('/api/auth/login', { method: 'POST', body });
      return requestJson(MeDto, '/api/auth/me');
    },
    onSuccess: (me) => {
      client.setQueryData(['me'], me);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      clearPersisted();
      client.clear();
      client.setQueryData(['me'], null);
    },
  });
}

export function usePortals(enabled = true) {
  return useQuery({
    queryKey: ['portals'],
    queryFn: async () => portalsCache.save(await requestJson(z.array(PortalDto), '/api/portals')),
    initialData: portalsCache.initial,
    initialDataUpdatedAt: 0,
    enabled,
  });
}

export function useAddPortal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePortalRequest) =>
      requestJson(PortalDto, '/api/portals', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['portals'] }),
  });
}

export function useRemovePortal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (portalId: string) =>
      request(`/api/portals/${encodeURIComponent(portalId)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['portals'] }),
  });
}

const favoritesKey = ['favorites'];

export function useFavorites(enabled = true) {
  return useQuery({
    queryKey: favoritesKey,
    queryFn: async () => favoritesCache.save(await requestJson(z.array(FavoriteDto), '/api/favorites')),
    initialData: favoritesCache.initial,
    initialDataUpdatedAt: 0,
    enabled,
  });
}

export const favoriteKey = (portalId: string, channelId: string): string => `${portalId}:${channelId}`;

/**
 * Ajout ou retrait d'un favori, appliqué tout de suite à l'écran (optimiste) puis confirmé
 * par le serveur ; en cas d'échec, l'état précédent revient.
 */
export function useToggleFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      portalId,
      channelId,
      on,
    }: {
      portalId: string;
      channelId: string;
      on: boolean;
      /** Chaîne fusionnée : ses sources, retirées elles aussi de l'affichage dès le clic. */
      sources?: readonly { portalId: string; channelId: string }[];
    }) =>
      request(`/api/favorites/${encodeURIComponent(portalId)}/${encodeURIComponent(channelId)}`, {
        method: on ? 'PUT' : 'DELETE',
      }),
    onMutate: async ({ portalId, channelId, on, sources = [] }) => {
      await client.cancelQueries({ queryKey: favoritesKey });
      const previous = client.getQueryData<FavoriteDto[]>(favoritesKey);
      const matches = (f: FavoriteDto): boolean =>
        [{ portalId, channelId }, ...sources].some(
          (r) => r.portalId === f.portalId && r.channelId === f.channelId,
        );
      const rest = (previous ?? []).filter((f) => !matches(f));
      client.setQueryData<FavoriteDto[]>(
        favoritesKey,
        on ? [...rest, { portalId, channelId, addedAt: Date.now() }] : rest,
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      client.setQueryData(favoritesKey, context?.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: favoritesKey }),
  });
}

/**
 * Le portail répond-il ? Revérifié chaque minute ; la réponse vient vite (délai court côté
 * serveur). Injoignable, il est revérifié plus souvent pour retirer le message dès son retour.
 */
const PORTAL_HEALTH_REFRESH_MS = 60_000;
const PORTAL_DOWN_REFRESH_MS = 15_000;

export function usePortalHealth(portalId: string | null) {
  return useQuery({
    queryKey: ['portal-health', portalId],
    queryFn: () => requestJson(PortalHealthDto, `/api/portals/${encodeURIComponent(portalId ?? '')}/health`),
    enabled: portalId !== null,
    refetchInterval: (query) =>
      query.state.data?.reachable === false ? PORTAL_DOWN_REFRESH_MS : PORTAL_HEALTH_REFRESH_MS,
    retry: false,
  });
}

export function useRecents(enabled = true) {
  return useQuery({
    queryKey: ['recents'],
    queryFn: async () => recentsCache.save(await requestJson(z.array(RecentDto), '/api/recents')),
    initialData: recentsCache.initial,
    initialDataUpdatedAt: 0,
    enabled,
  });
}

const mergeKey = ['merge'];

/** Réglages de la fusion des portails (d'installation) : active ou non, corrections manuelles. */
export function useMergeSettings(enabled = true) {
  return useQuery({
    queryKey: mergeKey,
    queryFn: () => requestJson(MergeSettingsDto, '/api/catalog/merge'),
    enabled,
  });
}

/** Après un changement : réglages relus, catalogue fusionné revalidé (nouvelle version). */
function useMergeMutation<T>(path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => requestJson(MergeSettingsDto, path, { method: 'PUT', body }),
    onSuccess: async (settings) => {
      client.setQueryData(mergeKey, settings);
      await client.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}

export const useSetMergeEnabled = () => useMergeMutation<{ enabled: boolean }>('/api/catalog/merge');
export const useSetMergeOverride = () =>
  useMergeMutation<MergeOverrideRequest>('/api/catalog/merge/overrides');

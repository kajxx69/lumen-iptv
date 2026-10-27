import {
  type CreatePortalRequest,
  FavoriteDto,
  type LoginRequest,
  MeDto,
  PortalDto,
  RecentDto,
} from '@lumen/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, request, requestJson } from './client.js';

/**
 * Dernière réponse gardée sur l'appareil pour les petites listes (portails, favoris,
 * récents) : hors ligne, l'application s'ouvre avec elles au lieu d'un écran vide.
 */
function persisted<S extends z.ZodType>(key: string, schema: S) {
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
  for (const key of ['portals', 'favorites', 'recents']) {
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
    mutationFn: ({ portalId, channelId, on }: { portalId: string; channelId: string; on: boolean }) =>
      request(`/api/favorites/${encodeURIComponent(portalId)}/${encodeURIComponent(channelId)}`, {
        method: on ? 'PUT' : 'DELETE',
      }),
    onMutate: async ({ portalId, channelId, on }) => {
      await client.cancelQueries({ queryKey: favoritesKey });
      const previous = client.getQueryData<FavoriteDto[]>(favoritesKey);
      const rest = (previous ?? []).filter((f) => !(f.portalId === portalId && f.channelId === channelId));
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

export function useRecents(enabled = true) {
  return useQuery({
    queryKey: ['recents'],
    queryFn: async () => recentsCache.save(await requestJson(z.array(RecentDto), '/api/recents')),
    initialData: recentsCache.initial,
    initialDataUpdatedAt: 0,
    enabled,
  });
}

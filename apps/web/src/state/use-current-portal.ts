import { ALL_PORTALS_ID, type PortalDto } from '@lumen/protocol';
import { useMergeSettings, usePortals } from '../api/queries.js';
import { usePrefs } from './prefs.js';

/**
 * Vue « Tous les portails » : un portail virtuel dont chaque chaîne réunit ses sources.
 * Proposée dès deux portails, si la fusion est active ; c'est alors la vue par défaut.
 */
export const ALL_PORTALS: PortalDto = {
  id: ALL_PORTALS_ID,
  name: 'Tous les portails',
  host: '',
  macMasked: '',
  device: 'MAG250',
  createdAt: 0,
};

export const isAllPortals = (portal: PortalDto | null): boolean => portal?.id === ALL_PORTALS_ID;

/** Portail affiché : le choix mémorisé sur cet appareil, sinon le premier proposé. */
export function useCurrentPortal(): { portal: PortalDto | null; portals: PortalDto[]; loading: boolean } {
  const portals = usePortals();
  const real = portals.data ?? [];
  const merge = useMergeSettings(real.length > 1);
  const chosen = usePrefs((s) => s.portalId);
  // Réglage inconnu (hors ligne) : la vue choisie sur cet appareil reste disponible, son
  // catalogue est dans IndexedDB.
  const merged = merge.data?.enabled ?? chosen === ALL_PORTALS_ID;
  const list = real.length > 1 && merged ? [ALL_PORTALS, ...real] : real;
  // Le temps de connaître le réglage : rien d'affiché plutôt qu'un portail puis un autre.
  if (real.length > 1 && merge.isLoading) return { portal: null, portals: real, loading: true };
  const portal = list.find((p) => p.id === chosen) ?? list[0] ?? null;
  return { portal, portals: list, loading: portals.isLoading };
}

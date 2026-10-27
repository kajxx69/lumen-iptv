import type { PortalDto } from '@lumen/protocol';
import { usePortals } from '../api/queries.js';
import { usePrefs } from './prefs.js';

/** Portail affiché : le choix mémorisé sur cet appareil, sinon le premier enregistré. */
export function useCurrentPortal(): { portal: PortalDto | null; portals: PortalDto[]; loading: boolean } {
  const portals = usePortals();
  const chosen = usePrefs((s) => s.portalId);
  const list = portals.data ?? [];
  const portal = list.find((p) => p.id === chosen) ?? list[0] ?? null;
  return { portal, portals: list, loading: portals.isLoading };
}

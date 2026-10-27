import type { PortalHealthDto } from '@lumen/protocol';
import type { CatalogStore } from '../store/catalog-store.js';
import type { PortalRegistry } from './registry.js';

/** Au-delà, le portail est déclaré injoignable : l'utilisateur n'attend pas plus pour être prévenu. */
const HEALTH_TIMEOUT_MS = 4000;

/**
 * Le portail répond-il ? Une requête légère (informations du compte), avec un délai court.
 * Le résultat sert au message « portail injoignable ». Aucun résultat n'est gardé : une
 * panne survenue juste après une vérification réussie doit se voir dès la relance de
 * l'application. Les demandes simultanées (plusieurs écrans) partagent la même requête.
 */
export class PortalHealth {
  private readonly inFlight = new Map<string, Promise<PortalHealthDto>>();

  constructor(
    private readonly registry: PortalRegistry,
    private readonly catalogs: CatalogStore,
  ) {}

  check(portalId: string): Promise<PortalHealthDto> {
    const running = this.inFlight.get(portalId);
    if (running !== undefined) return running;
    const result = this.probe(portalId).finally(() => {
      this.inFlight.delete(portalId);
    });
    this.inFlight.set(portalId, result);
    return result;
  }

  private async probe(portalId: string): Promise<PortalHealthDto> {
    const portal = this.registry.get(portalId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, HEALTH_TIMEOUT_MS);
    });
    const reachable = await Promise.race([
      portal.provider.client.getAccountInfo().then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
    clearTimeout(timer);
    return {
      portalId,
      reachable,
      checkedAt: Date.now(),
      syncedAt: this.catalogs.meta(portalId)?.syncedAt ?? null,
    };
  }
}

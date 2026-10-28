import { ALL_PORTALS_ID, type FavoriteDto, type RecentDto } from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { MergeService } from '../catalog/merge-service.js';
import { requireUser } from '../http/auth.js';
import { notFound, parseOr400 } from '../http/errors.js';
import type { LibraryStore } from '../store/library-store.js';

const FavoriteParams = z.object({ portalId: z.string().min(1), channelId: z.string().min(1) });

export function registerLibraryRoutes(
  app: FastifyInstance,
  { library, catalog, merge }: { library: LibraryStore; catalog: CatalogService; merge: MergeService },
): void {
  /** Chaîne fusionnée : ses sources réelles ; on ne range jamais que des chaînes de portail. */
  const sourcesOf = (portalId: string, channelId: string) => {
    if (portalId !== ALL_PORTALS_ID) return [{ portalId, channelId }];
    const members = merge.members(channelId);
    if (members === null) throw notFound('chaîne');
    return members;
  };

  app.get('/api/favorites', (req): FavoriteDto[] => library.favorites(requireUser(req).id));

  app.put('/api/favorites/:portalId/:channelId', async (req, reply) => {
    const user = requireUser(req);
    const { portalId, channelId } = parseOr400(FavoriteParams, req.params);
    // Chaîne fusionnée : sa première source porte le favori, toutes le retrouvent.
    const ref = sourcesOf(portalId, channelId)[0];
    // Seule une chaîne existante peut devenir favorite (portail inconnu : 404 aussi).
    if (ref === undefined || (await catalog.channel(ref.portalId, ref.channelId)) === null) {
      throw notFound('chaîne');
    }
    library.addFavorite(user.id, ref.portalId, ref.channelId, Date.now());
    return reply.code(204).send();
  });

  app.delete('/api/favorites/:portalId/:channelId', async (req, reply) => {
    const user = requireUser(req);
    const { portalId, channelId } = parseOr400(FavoriteParams, req.params);
    for (const ref of sourcesOf(portalId, channelId))
      library.removeFavorite(user.id, ref.portalId, ref.channelId);
    return reply.code(204).send();
  });

  app.get('/api/recents', (req): RecentDto[] => library.recents(requireUser(req).id));
}

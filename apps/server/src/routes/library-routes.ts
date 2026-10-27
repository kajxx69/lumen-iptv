import type { FavoriteDto, RecentDto } from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../catalog/catalog-service.js';
import { requireUser } from '../http/auth.js';
import { notFound, parseOr400 } from '../http/errors.js';
import type { LibraryStore } from '../store/library-store.js';

const FavoriteParams = z.object({ portalId: z.string().min(1), channelId: z.string().min(1) });

export function registerLibraryRoutes(
  app: FastifyInstance,
  { library, catalog }: { library: LibraryStore; catalog: CatalogService },
): void {
  app.get('/api/favorites', (req): FavoriteDto[] => library.favorites(requireUser(req).id));

  app.put('/api/favorites/:portalId/:channelId', async (req, reply) => {
    const user = requireUser(req);
    const { portalId, channelId } = parseOr400(FavoriteParams, req.params);
    // Seule une chaîne existante peut devenir favorite (portail inconnu : 404 aussi).
    if ((await catalog.channel(portalId, channelId)) === null) throw notFound('chaîne');
    library.addFavorite(user.id, portalId, channelId, Date.now());
    return reply.code(204).send();
  });

  app.delete('/api/favorites/:portalId/:channelId', async (req, reply) => {
    const user = requireUser(req);
    const { portalId, channelId } = parseOr400(FavoriteParams, req.params);
    library.removeFavorite(user.id, portalId, channelId);
    return reply.code(204).send();
  });

  app.get('/api/recents', (req): RecentDto[] => library.recents(requireUser(req).id));
}

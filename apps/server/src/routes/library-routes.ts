import {
  ALL_PORTALS_ID,
  type FavoriteDto,
  ProgressKind,
  type ProgressDto,
  ProgressUpdateRequest,
  type RecentDto,
} from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { MergeService } from '../catalog/merge-service.js';
import { requireUser } from '../http/auth.js';
import { notFound, parseOr400 } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { LibraryStore } from '../store/library-store.js';
import type { ProgressStore } from '../store/progress-store.js';

const FavoriteParams = z.object({ portalId: z.string().min(1), channelId: z.string().min(1) });
const ProgressParams = z.object({
  kind: ProgressKind,
  portalId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128),
});

export function registerLibraryRoutes(
  app: FastifyInstance,
  {
    library,
    catalog,
    merge,
    progress,
    registry,
  }: {
    library: LibraryStore;
    catalog: CatalogService;
    merge: MergeService;
    progress: ProgressStore;
    registry: PortalRegistry;
  },
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

  /** Positions de lecture des films et épisodes : « Reprendre » sur tous les appareils du compte. */
  app.get('/api/progress', (req): ProgressDto[] => progress.list(requireUser(req).id));

  app.put('/api/progress', (req, reply) => {
    const user = requireUser(req);
    const update = parseOr400(ProgressUpdateRequest, req.body);
    // Portail inconnu : 404. Le titre, lui, n'est pas vérifié : ce serait un appel au portail par envoi.
    registry.get(update.portalId);
    progress.save(user.id, update, Date.now());
    return reply.code(204).send();
  });

  app.delete('/api/progress/:kind/:portalId/:itemId', (req, reply) => {
    const user = requireUser(req);
    const { kind, portalId, itemId } = parseOr400(ProgressParams, req.params);
    progress.remove(user.id, kind, portalId, itemId);
    return reply.code(204).send();
  });
}

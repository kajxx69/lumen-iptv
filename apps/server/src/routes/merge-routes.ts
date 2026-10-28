import { MergeOverrideRequest, type MergeSettingsDto, MergeSettingsRequest } from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import type { MergeService } from '../catalog/merge-service.js';
import { requireAdmin, requireUser } from '../http/auth.js';
import { parseOr400 } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { MergeStore } from '../store/merge-store.js';

/**
 * Réglages de la fusion multi-portails : valables pour toute l'installation, modifiables
 * par l'administrateur seul (une correction change la liste de tous les comptes).
 */
export function registerMergeRoutes(
  app: FastifyInstance,
  { merge, store, registry }: { merge: MergeService; store: MergeStore; registry: PortalRegistry },
): void {
  app.get('/api/catalog/merge', (req): MergeSettingsDto => {
    requireUser(req);
    return merge.settings();
  });

  app.put('/api/catalog/merge', (req): MergeSettingsDto => {
    requireAdmin(req);
    const { enabled } = parseOr400(MergeSettingsRequest, req.body);
    store.setEnabled(enabled);
    req.log.info({ enabled }, 'fusion des portails réglée');
    return merge.settings();
  });

  app.put('/api/catalog/merge/overrides', (req): MergeSettingsDto => {
    requireAdmin(req);
    const { portalId, channelId, target } = parseOr400(MergeOverrideRequest, req.body);
    // Portail inconnu : 404, comme partout ailleurs.
    registry.get(portalId);
    store.setOverride(portalId, channelId, target, Date.now());
    req.log.info({ portal: portalId, channel: channelId, cleared: target === null }, 'fusion corrigée');
    return merge.settings();
  });
}

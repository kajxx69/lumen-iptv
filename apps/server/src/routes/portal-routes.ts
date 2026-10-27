import { StalkerError } from '@lumen/core/stalker';
import {
  CreatePortalRequest,
  EPG_BATCH_MAX_CHANNELS,
  type EpgBatchDto,
  type EpgEntryDto,
  type PortalDto,
  type VodPageDto,
} from '@lumen/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { ServerConfig } from '../config.js';
import { requireAdmin, requireUser } from '../http/auth.js';
import { ApiError, fromStalker, notFound, parseOr400 } from '../http/errors.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { PortalRecord, PortalStore } from '../store/portal-store.js';

const MAC_VISIBLE_OCTETS = 2;
const HOUR_MS = 3_600_000;

const maskMac = (mac: string): string =>
  mac
    .toUpperCase()
    .split(':')
    .map((octet, i, all) => (i < all.length - MAC_VISIBLE_OCTETS ? '**' : octet))
    .join(':');

const toDto = (p: PortalRecord): PortalDto => ({
  id: p.id,
  name: p.name,
  host: new URL(p.secret.url).host,
  macMasked: maskMac(p.secret.mac),
  device: p.secret.device,
  createdAt: p.createdAt,
});

const PortalParams = z.object({ portalId: z.string().min(1) });
const ChannelParams = PortalParams.extend({ channelId: z.string().min(1) });
const EpgQuery = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() });
const EpgBatchQuery = EpgQuery.extend({
  channels: z
    .string()
    .transform((s) => [...new Set(s.split(',').filter((id) => id !== ''))])
    .pipe(z.array(z.string().max(64)).min(1).max(EPG_BATCH_MAX_CHANNELS)),
});
const VodQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  category: z.string().default('*'),
  search: z.string().max(100).optional(),
});

interface PortalRouteDeps {
  store: PortalStore;
  registry: PortalRegistry;
  catalog: CatalogService;
  config: ServerConfig;
}

export function registerPortalRoutes(
  app: FastifyInstance,
  { store, registry, catalog, config }: PortalRouteDeps,
): void {
  app.get('/api/portals', (req): PortalDto[] => {
    requireUser(req);
    return store.list().map(toDto);
  });

  app.post('/api/portals', async (req, reply) => {
    requireAdmin(req);
    const body = parseOr400(CreatePortalRequest, req.body);
    const secret = {
      url: body.url,
      mac: body.mac.toUpperCase(),
      device: body.device,
      ...(body.login === undefined || body.login === '' ? {} : { login: body.login }),
      ...(body.password === undefined || body.password === '' ? {} : { password: body.password }),
    };
    // Vérifié avant d'être enregistré : l'utilisateur sait tout de suite si l'abonnement marche.
    try {
      await registry.verify(secret);
    } catch (err) {
      if (err instanceof StalkerError) {
        req.log.info({ kind: err.kind }, 'portail refusé à l’ajout');
        throw fromStalker(err, 422);
      }
      throw err;
    }
    const record = store.create(body.name, secret, Date.now());
    req.log.info({ portal: record.id }, 'portail ajouté');
    return reply.code(201).send(toDto(record));
  });

  app.delete('/api/portals/:portalId', async (req, reply) => {
    requireAdmin(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    registry.remove(portalId);
    catalog.forget(portalId);
    if (!store.delete(portalId)) throw notFound('portail');
    return reply.code(204).send();
  });

  app.post('/api/portals/:portalId/sync', async (req) => {
    requireAdmin(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    return catalog.sync(portalId);
  });

  app.get('/api/portals/:portalId/genres', async (req) => {
    requireUser(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    return catalog.genres(portalId);
  });

  app.get('/api/portals/:portalId/channels', async (req, reply) => {
    requireUser(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    const list = await catalog.channels(portalId);
    const etag = `"${list.version}"`;
    // Revalidation systématique, mais un catalogue inchangé ne coûte qu'un 304.
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return list;
  });

  app.get('/api/portals/:portalId/channels/:channelId/logo', async (req, reply) => {
    requireUser(req);
    const { portalId, channelId } = parseOr400(ChannelParams, req.params);
    const channel = await catalog.channel(portalId, channelId);
    if (channel?.logo == null) throw notFound('logo');
    const portal = registry.get(portalId);
    const url = channel.logo.startsWith('/') ? `${portal.origin}${channel.logo}` : channel.logo;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': portal.userAgent },
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch {
      throw notFound('logo');
    }
    const type = res.headers.get('content-type') ?? '';
    // Seules des images passent : le proxy de logos ne doit pas servir n'importe quel contenu.
    if (!res.ok || !type.startsWith('image/')) throw notFound('logo');
    return reply
      .header('Content-Type', type)
      .header('Cache-Control', `private, max-age=${config.logoCacheMaxAgeS}`)
      .send(Buffer.from(await res.arrayBuffer()));
  });

  app.get('/api/portals/:portalId/channels/:channelId/epg', async (req): Promise<EpgEntryDto[]> => {
    requireUser(req);
    const { portalId, channelId } = parseOr400(ChannelParams, req.params);
    const { from, to } = parseOr400(EpgQuery, req.query);
    if (to <= from || to - from > config.epgMaxWindowMs) {
      throw new ApiError(400, 'bad_request', 'fenêtre EPG invalide ou trop large');
    }
    const entries = await epgCache.get(portalId, channelId, from, to);
    return entries;
  });

  /**
   * EPG de plusieurs chaînes en une requête (lignes visibles du guide). Une chaîne en échec
   * renvoie une liste vide plutôt que de priver les autres de leur programme.
   */
  app.get('/api/portals/:portalId/epg', async (req): Promise<EpgBatchDto> => {
    requireUser(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    const { channels, from, to } = parseOr400(EpgBatchQuery, req.query);
    if (to <= from || to - from > config.epgMaxWindowMs) {
      throw new ApiError(400, 'bad_request', 'fenêtre EPG invalide ou trop large');
    }
    registry.get(portalId);
    const lists = await Promise.all(
      channels.map((id) => epgCache.get(portalId, id, from, to).catch((): EpgEntryDto[] => [])),
    );
    return Object.fromEntries(channels.map((id, i) => [id, lists[i] ?? []]));
  });

  app.get('/api/portals/:portalId/vod', async (req): Promise<VodPageDto> => {
    requireUser(req);
    const { portalId } = parseOr400(PortalParams, req.params);
    const query = parseOr400(VodQuery, req.query);
    const page = await registry.get(portalId).provider.client.getVodPage({
      page: query.page,
      category: query.category,
      ...(query.search === undefined ? {} : { search: query.search }),
    });
    return {
      page: query.page,
      pageSize: page.pageSize,
      totalItems: page.totalItems,
      items: page.items.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        year: m.year,
        durationMin: m.durationMin,
        rating: m.rating,
        categoryId: m.categoryId,
        censored: m.censored,
      })),
    };
  });

  /**
   * Cache EPG par heure pleine : des fenêtres voisines (défilement du guide) réutilisent
   * la même grille au lieu de réinterroger le portail.
   */
  const epgCache = {
    entries: new Map<string, { at: number; data: Promise<EpgEntryDto[]> }>(),
    async get(portalId: string, channelId: string, from: number, to: number): Promise<EpgEntryDto[]> {
      const start = Math.floor(from / HOUR_MS) * HOUR_MS;
      const end = Math.ceil(to / HOUR_MS) * HOUR_MS;
      const key = `${portalId}|${channelId}|${start}|${end}`;
      const now = Date.now();
      let hit = this.entries.get(key);
      if (hit === undefined || now - hit.at > config.epgCacheTtlMs) {
        const data = registry
          .get(portalId)
          .provider.getEpg(channelId, { from: start, to: end })
          .then((list) =>
            list.map((e) => ({
              id: e.id,
              title: e.title,
              description: e.description,
              category: e.category,
              start: e.start,
              end: e.end,
              catchup: e.catchup !== null,
            })),
          );
        hit = { at: now, data };
        this.entries.set(key, hit);
        // Une erreur ne doit pas rester en cache.
        data.catch(() => this.entries.delete(key));
      }
      return (await hit.data).filter((e) => e.end > from && e.start < to);
    },
  };
}

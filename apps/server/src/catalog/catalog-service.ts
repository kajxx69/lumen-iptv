import { createHash } from 'node:crypto';
import type { ChannelDto, ChannelListDto, GenreDto } from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { ActivePortal, PortalRegistry } from '../portals/registry.js';
import type { CatalogStore, StoredChannel } from '../store/catalog-store.js';

const VERSION_HEX_LENGTH = 20;

export interface SyncResult {
  channels: number;
  version: string;
}

/** Logo stocké sans l'adresse du portail quand il est servi par lui (voir StoredChannel). */
function storableLogo(logo: string, portalOrigin: string): string | null {
  if (logo.trim() === '') return null;
  return logo.startsWith(`${portalOrigin}/`) ? logo.slice(portalOrigin.length) : logo;
}

export const logoPath = (portalId: string, channelId: string): string =>
  `/api/portals/${encodeURIComponent(portalId)}/channels/${encodeURIComponent(channelId)}/logo`;

function toDto(portalId: string, c: StoredChannel): ChannelDto {
  return {
    id: c.id,
    name: c.name,
    number: c.number,
    genreId: c.genreId,
    logo: c.logo === null ? null : logoPath(portalId, c.id),
    epgId: c.epgId,
    archiveHours: c.archiveHours,
    censored: c.censored,
  };
}

/**
 * Catalogue servi depuis SQLite : ouverture instantanée, y compris portail hors service.
 * Une copie trop ancienne est servie telle quelle pendant qu'une synchronisation tourne
 * en arrière-plan : l'utilisateur n'attend jamais le portail, sauf au tout premier chargement.
 */
export class CatalogService {
  private readonly syncing = new Map<string, Promise<SyncResult>>();
  /** Liste sérialisée en mémoire par portail, invalidée par la version. */
  private readonly memo = new Map<string, ChannelListDto>();

  constructor(
    private readonly store: CatalogStore,
    private readonly registry: PortalRegistry,
    private readonly config: ServerConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  sync(portalId: string): Promise<SyncResult> {
    const running = this.syncing.get(portalId);
    if (running !== undefined) return running;
    const task = this.runSync(this.registry.get(portalId)).finally(() => this.syncing.delete(portalId));
    this.syncing.set(portalId, task);
    return task;
  }

  private async runSync(portal: ActivePortal): Promise<SyncResult> {
    const started = Date.now();
    const { client } = portal.provider;
    const genres: GenreDto[] = (await client.getGenres()).map((g) => ({
      id: g.id,
      title: g.title,
      censored: g.censored,
    }));
    const channels: StoredChannel[] = [];
    for await (const c of client.listChannels()) {
      channels.push({
        id: c.id,
        name: c.name,
        number: c.number,
        genreId: c.genreId,
        logo: storableLogo(c.logo, portal.origin),
        epgId: c.xmltvId === '' ? null : c.xmltvId,
        archiveHours: c.archive ? c.archiveHours : 0,
        censored: c.censored,
        cmd: c.cmd,
      });
    }
    const version = createHash('sha256')
      .update(JSON.stringify([genres, channels]))
      .digest('hex')
      .slice(0, VERSION_HEX_LENGTH);
    this.store.replace(portal.record.id, channels, genres, version, Date.now());
    this.memo.delete(portal.record.id);
    this.log.info(
      { portal: portal.record.id, channels: channels.length, version, ms: Date.now() - started },
      'catalogue synchronisé',
    );
    return { channels: channels.length, version };
  }

  /** Garantit qu'une copie existe ; lance un rafraîchissement de fond si elle a vieilli. */
  private async ensure(portalId: string): Promise<void> {
    this.registry.get(portalId);
    const meta = this.store.meta(portalId);
    if (meta === null) {
      await this.sync(portalId);
      return;
    }
    if (Date.now() - meta.syncedAt > this.config.catalogTtlMs) {
      this.sync(portalId).catch((err: unknown) => {
        // Le portail est peut-être tombé : la copie existante reste servie.
        this.log.warn(
          { portal: portalId, err: err instanceof Error ? err.message : 'inconnue' },
          'rafraîchissement du catalogue en échec',
        );
      });
    }
  }

  async channels(portalId: string): Promise<ChannelListDto> {
    await this.ensure(portalId);
    const meta = this.store.meta(portalId);
    if (meta === null) throw new Error('catalogue absent après synchronisation');
    const memo = this.memo.get(portalId);
    if (memo?.version === meta.version && memo.syncedAt === meta.syncedAt) return memo;
    const dto: ChannelListDto = {
      portalId,
      version: meta.version,
      syncedAt: meta.syncedAt,
      channels: this.store.channels(portalId).map((c) => toDto(portalId, c)),
    };
    this.memo.set(portalId, dto);
    return dto;
  }

  async genres(portalId: string): Promise<GenreDto[]> {
    await this.ensure(portalId);
    return this.store.meta(portalId)?.genres ?? [];
  }

  /** Chaîne avec sa commande de lecture : réservé au serveur (lecture, logos). */
  async channel(portalId: string, channelId: string): Promise<StoredChannel | null> {
    await this.ensure(portalId);
    return this.store.channel(portalId, channelId);
  }

  /**
   * Sources de secours trouvées sans l'aide du client : la même chaîne (même identifiant
   * EPG) sur les autres portails dont le catalogue est connu. Aucun portail n'est
   * interrogé ici : la recherche reste instantanée au lancement d'une chaîne.
   */
  async alternatives(
    portalId: string,
    channelId: string,
  ): Promise<{ portalId: string; channelId: string }[]> {
    const channel = await this.channel(portalId, channelId);
    if (channel?.epgId == null || channel.epgId === '') return [];
    return this.store.findByEpgId(channel.epgId, portalId);
  }

  forget(portalId: string): void {
    this.memo.delete(portalId);
  }
}

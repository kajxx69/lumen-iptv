import type {
  Channel,
  EpgEntry,
  ListOptions,
  ProviderCapabilities,
  ResolvedStream,
  Session,
  SourceProvider,
  StreamRef,
  TimeWindow,
  VodItem,
} from '../sources/index.js';
import { StalkerClient, type StalkerClientOptions } from './client.js';
import { StalkerError } from './errors.js';
import type { Runtime } from './runtime.js';

export interface StalkerProviderOptions extends StalkerClientOptions {
  /** Identifiant stable de ce portail dans la configuration de l'utilisateur. */
  id: string;
}

const nonEmpty = (s: string): string | null => (s.trim() === '' ? null : s);

/** Adapte le client Stalker à l'interface commune des sources. */
export class StalkerProvider implements SourceProvider {
  readonly id: string;
  readonly client: StalkerClient;

  constructor(options: StalkerProviderOptions, runtime: Runtime) {
    this.id = options.id;
    this.client = new StalkerClient(options, runtime);
  }

  private ref(kind: StreamRef['kind'], cmd: string): StreamRef {
    return { providerId: this.id, kind, cmd };
  }

  async authenticate(): Promise<Session> {
    const session = await this.client.authenticate();
    return {
      providerId: this.id,
      status: session.status,
      expiresAt: session.expiresAt,
      openedAt: session.openedAt,
    };
  }

  async *listChannels(opts: ListOptions = {}): AsyncGenerator<Channel> {
    const source = this.client.listChannels({
      ...(opts.categoryId === undefined ? {} : { genre: opts.categoryId }),
      ...(opts.startPage === undefined ? {} : { startPage: opts.startPage }),
    });
    for await (const c of source) {
      yield {
        providerId: this.id,
        id: c.id,
        name: c.name,
        number: c.number,
        categoryId: c.genreId,
        logoUrl: nonEmpty(c.logo),
        epgId: nonEmpty(c.xmltvId),
        archiveHours: c.archive ? c.archiveHours : 0,
        censored: c.censored,
        stream: this.ref('live', c.cmd),
      };
    }
  }

  async *listVod(opts: ListOptions = {}): AsyncGenerator<VodItem> {
    const source = this.client.listVod({
      ...(opts.categoryId === undefined ? {} : { category: opts.categoryId }),
      ...(opts.search === undefined ? {} : { search: opts.search }),
      ...(opts.startPage === undefined ? {} : { startPage: opts.startPage }),
    });
    for await (const m of source) {
      yield {
        providerId: this.id,
        id: m.id,
        name: m.name,
        description: m.description,
        year: m.year,
        durationMin: m.durationMin,
        rating: m.rating,
        categoryId: m.categoryId,
        posterUrl: nonEmpty(m.poster),
        censored: m.censored,
        stream: this.ref('vod', m.cmd),
      };
    }
  }

  async resolveStream(ref: StreamRef): Promise<ResolvedStream> {
    if (ref.providerId !== this.id) {
      throw new StalkerError('invalid_config', 'référence de flux émise par une autre source');
    }
    const resolvers = {
      live: (cmd: string) => this.client.createLink(cmd),
      vod: (cmd: string) => this.client.createVodLink(cmd),
      episode: (cmd: string) => this.client.createEpisodeLink(cmd),
      radio: (cmd: string) => this.client.createRadioLink(cmd),
      archive: (cmd: string) => this.client.createArchiveLink(cmd),
    } as const;
    const link = await resolvers[ref.kind](ref.cmd);
    return { url: link.url, format: link.format, kind: ref.kind, resolvedAt: link.resolvedAt };
  }

  async getEpg(channelId: string, window: TimeWindow): Promise<EpgEntry[]> {
    const programmes = await this.client.getEpg(channelId, window);
    return programmes.map((p) => ({
      id: p.id,
      channelId: p.channelId,
      title: p.name,
      description: p.description,
      category: p.category,
      start: p.start,
      end: p.end,
      catchup: p.archived && p.cmd !== '' ? this.ref('archive', p.cmd) : null,
    }));
  }

  capabilities(): ProviderCapabilities {
    return { live: true, vod: true, series: true, radio: true, epg: true, archive: true, favorites: true };
  }

  close(): void {
    this.client.close();
  }
}

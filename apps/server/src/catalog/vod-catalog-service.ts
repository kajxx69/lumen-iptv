import { createHash } from 'node:crypto';
import { fingerprintName, normalizeName } from '@lumen/core/catalog';
import type { StalkerEpisode, StalkerGenre, StalkerSeason } from '@lumen/core/stalker';
import {
  ALL_PORTALS_ID,
  type EpisodeDto,
  type GenreDto,
  type MovieDetailDto,
  type MovieListDto,
  type MovieSummaryDto,
  type SeriesDetailDto,
  type SeriesListDto,
  type SeriesSummaryDto,
  type VodSourceDto,
} from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { notFound } from '../http/errors.js';
import type { ActivePortal, PortalRegistry } from '../portals/registry.js';
import type { StoredMovie, StoredSeries, VodItemOf, VodKind, VodMeta, VodStore } from '../store/vod-store.js';
import { storableLogo } from './catalog-service.js';

const VERSION_HEX_LENGTH = 20;
/** Saisons et épisodes gardés en mémoire au plus, toutes séries confondues (une fiche ouverte en coûte une). */
const SERIES_CACHE_MAX_ENTRIES = 500;
/** Catégorie « tout » des portails : un filtre, pas une catégorie. */
const ALL_CATEGORY_ID = '*';

export interface VodCatalogOptions {
  /** Âge au-delà duquel le catalogue est relu en arrière-plan (servi entre-temps). */
  ttlMs: number;
  /** Saisons et épisodes d'une série gardés ce temps : une fiche rouverte ne réinterroge pas le portail. */
  seriesCacheTtlMs: number;
}

export interface VodCatalogDeps {
  store: VodStore;
  registry: PortalRegistry;
  /** Portails enregistrés, dans l'ordre d'ajout : la vue « Tous les portails » les réunit. */
  portalIds: () => string[];
  log: FastifyBaseLogger;
}

/** Lecture en cours : ce qui est déjà lu est servi, la liste grandit page après page. */
interface Progress {
  items: (StoredMovie | StoredSeries)[];
  categories: GenreDto[];
  done: Promise<void>;
  /** Résolu dès le premier titre (ou la fin) : un tout premier affichage n'attend pas tout le catalogue. */
  firstPage: Promise<void>;
}

type ListOf<K extends VodKind> = K extends 'movie' ? MovieListDto : SeriesListDto;
type Summary = MovieSummaryDto | SeriesSummaryDto;

export const posterPath = (portalId: string, kind: VodKind, id: string): string =>
  `/api/portals/${encodeURIComponent(portalId)}/${kind === 'movie' ? 'movies' : 'series'}/${encodeURIComponent(id)}/poster`;

/** Identifiant d'un titre de la vue « Tous les portails » : son portail préféré et son identifiant là-bas. */
export const mergedVodId = (portalId: string, id: string): string => `${portalId}:${id}`;

const categoriesOf = (genres: StalkerGenre[]): GenreDto[] =>
  genres
    .filter((g) => g.id !== ALL_CATEGORY_ID)
    .map((g) => ({ id: g.id, title: g.title, censored: g.censored }));

function movieSummary(portalId: string, m: StoredMovie): MovieSummaryDto {
  return {
    id: m.id,
    name: m.name,
    year: m.year,
    rating: m.rating,
    durationMin: m.durationMin,
    categoryId: m.categoryId,
    poster: m.poster === null ? null : posterPath(portalId, 'movie', m.id),
    censored: m.censored,
  };
}

function seriesSummary(portalId: string, s: StoredSeries): SeriesSummaryDto {
  return {
    id: s.id,
    name: s.name,
    year: s.year,
    categoryId: s.categoryId,
    poster: s.poster === null ? null : posterPath(portalId, 'series', s.id),
    censored: s.censored,
  };
}

const summaryOf = (portalId: string, kind: VodKind, item: StoredMovie | StoredSeries): Summary =>
  kind === 'movie' ? movieSummary(portalId, item as StoredMovie) : seriesSummary(portalId, item);

const versionOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, VERSION_HEX_LENGTH);

/**
 * Films et séries de chaque portail, conservés dans SQLite comme les chaînes : ouverture
 * instantanée, portail en panne compris. Un catalogue de VOD se lit page par page (14 titres
 * par appel, appels limités par seconde) : sur un grand portail, plusieurs minutes. Le tout
 * premier chargement sert donc la liste au fil de sa lecture ; les suivants, la copie
 * complète, relue en arrière-plan quand elle a vieilli.
 */
export class VodCatalogService {
  private readonly progress = new Map<string, Progress>();
  private readonly memo = new Map<string, MovieListDto | SeriesListDto>();
  private readonly seriesCache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly options: VodCatalogOptions,
    private readonly deps: VodCatalogDeps,
  ) {}

  /** Lit tout le catalogue du portail ; une seule lecture à la fois par portail et par genre. */
  sync(portalId: string, kind: VodKind): Promise<void> {
    const key = `${portalId}:${kind}`;
    const running = this.progress.get(key);
    if (running !== undefined) return running.done;
    const portal = this.deps.registry.get(portalId);
    let reachedFirstPage = (): void => undefined;
    const firstPage = new Promise<void>((resolve) => {
      reachedFirstPage = resolve;
    });
    const progress: Progress = { items: [], categories: [], done: Promise.resolve(), firstPage };
    progress.done = this.runSync(portal, kind, progress, reachedFirstPage).finally(() => {
      reachedFirstPage();
      this.progress.delete(key);
    });
    this.progress.set(key, progress);
    return progress.done;
  }

  private async runSync(
    portal: ActivePortal,
    kind: VodKind,
    progress: Progress,
    onFirstPage: () => void,
  ): Promise<void> {
    const started = Date.now();
    const { client } = portal.provider;
    const categories = categoriesOf(
      kind === 'movie' ? await client.getVodCategories() : await client.getSeriesCategories(),
    );
    progress.categories = categories;
    const censoredCategories = new Set(categories.filter((c) => c.censored).map((c) => c.id));
    const seen = new Set<string>();
    const add = (item: StoredMovie | StoredSeries): void => {
      // Un portail renvoie parfois un titre sur deux pages : il n'apparaît qu'une fois.
      if (seen.has(item.id)) return;
      seen.add(item.id);
      progress.items.push(item);
      if (progress.items.length === 1) onFirstPage();
    };
    if (kind === 'movie') {
      for await (const m of client.listVod()) {
        add({
          id: m.id,
          name: m.name,
          originalName: m.originalName,
          description: m.description,
          year: m.year,
          director: m.director,
          actors: m.actors,
          rating: m.rating,
          durationMin: m.durationMin,
          categoryId: m.categoryId,
          poster: storableLogo(m.poster, portal.origin),
          censored: m.censored || censoredCategories.has(m.categoryId),
          cmd: m.cmd,
          fingerprint: fingerprintName(m.name),
        });
      }
    } else {
      for await (const s of client.listSeries()) {
        add({
          id: s.id,
          name: s.name,
          description: s.description,
          year: s.year,
          categoryId: s.categoryId,
          poster: storableLogo(s.poster, portal.origin),
          censored: censoredCategories.has(s.categoryId),
          fingerprint: fingerprintName(s.name),
        });
      }
    }
    const version = versionOf([categories, progress.items]);
    this.deps.store.replace(portal.record.id, kind, progress.items, categories, version, Date.now());
    this.memo.delete(`${portal.record.id}:${kind}`);
    this.deps.log.info(
      { portal: portal.record.id, kind, items: progress.items.length, version, ms: Date.now() - started },
      'catalogue VOD synchronisé',
    );
  }

  /**
   * Garantit qu'une copie existe, ou qu'une lecture a commencé et livré son premier titre.
   * Une copie vieillie est servie pendant sa relecture en arrière-plan.
   */
  private async ensure(portalId: string, kind: VodKind): Promise<VodMeta | null> {
    this.deps.registry.get(portalId);
    const meta = this.deps.store.meta(portalId, kind);
    if (meta !== null && Date.now() - meta.syncedAt <= this.options.ttlMs) return meta;
    const task = this.sync(portalId, kind);
    if (meta !== null) {
      task.catch((err: unknown) => {
        // Le portail est peut-être tombé : la copie existante reste servie.
        this.deps.log.warn(
          { portal: portalId, kind, err: err instanceof Error ? err.message : 'inconnue' },
          'relecture du catalogue VOD en échec',
        );
      });
      return meta;
    }
    // Tout premier chargement : une panne du portail doit se voir, d'où l'attente de la
    // fin (rejet compris) ou du premier titre.
    const progress = this.progress.get(`${portalId}:${kind}`);
    await Promise.race([task, progress?.firstPage ?? task]);
    return this.deps.store.meta(portalId, kind);
  }

  movies(portalId: string): Promise<MovieListDto> {
    return this.list(portalId, 'movie');
  }

  series(portalId: string): Promise<SeriesListDto> {
    return this.list(portalId, 'series');
  }

  private async list<K extends VodKind>(portalId: string, kind: K): Promise<ListOf<K>> {
    if (portalId === ALL_PORTALS_ID) return this.mergedList(kind);
    const meta = await this.ensure(portalId, kind);
    if (meta === null) {
      // Première lecture en cours : ce qui est lu jusqu'ici.
      const progress = this.progress.get(`${portalId}:${kind}`);
      const items = progress?.items ?? [];
      return {
        portalId,
        version: `partiel-${items.length}`,
        syncedAt: Date.now(),
        complete: false,
        categories: progress?.categories ?? [],
        items: items.map((i) => summaryOf(portalId, kind, i)),
      } as ListOf<K>;
    }
    const key = `${portalId}:${kind}`;
    const memo = this.memo.get(key);
    if (memo?.version === meta.version && memo.syncedAt === meta.syncedAt) return memo as ListOf<K>;
    const dto = {
      portalId,
      version: meta.version,
      syncedAt: meta.syncedAt,
      complete: true,
      categories: meta.categories,
      items: this.deps.store.items(portalId, kind).map((i) => summaryOf(portalId, kind, i)),
    } as ListOf<K>;
    this.memo.set(key, dto);
    return dto;
  }

  /**
   * Vue « Tous les portails » : un titre présent sur plusieurs portails (même nom normalisé,
   * même année) n'apparaît qu'une fois, ses autres portails en sources de secours. Les
   * catégories se réunissent par intitulé. Un portail en panne n'empêche pas les autres.
   */
  private async mergedList<K extends VodKind>(kind: K): Promise<ListOf<K>> {
    const settled = await Promise.all(
      this.deps.portalIds().map((id) =>
        this.list(id, kind).then(
          (l): MovieListDto | SeriesListDto => l,
          () => null,
        ),
      ),
    );
    const lists = settled.filter((l): l is MovieListDto | SeriesListDto => l !== null);
    const categories = new Map<string, GenreDto>();
    const entries = new Map<string, Summary & { sources: VodSourceDto[] }>();
    for (const list of lists) {
      const categoryKey = new Map(list.categories.map((c) => [c.id, normalizeName(c.title)]));
      for (const c of list.categories) {
        const id = normalizeName(c.title);
        if (!categories.has(id)) categories.set(id, { id, title: c.title, censored: c.censored });
      }
      for (const item of list.items as Summary[]) {
        const stored = this.storedItem(list.portalId, kind, item.id);
        const key = `${stored?.fingerprint ?? mergedVodId(list.portalId, item.id)}|${item.year ?? ''}`;
        const source = { portalId: list.portalId, id: item.id };
        const existing = entries.get(key);
        if (existing !== undefined) {
          existing.sources.push(source);
          continue;
        }
        entries.set(key, {
          ...item,
          id: mergedVodId(list.portalId, item.id),
          categoryId: categoryKey.get(item.categoryId) ?? item.categoryId,
          sources: [source],
        });
      }
    }
    return {
      portalId: ALL_PORTALS_ID,
      version: versionOf(lists.map((l) => `${l.portalId}:${l.version}`)),
      syncedAt: lists.length === 0 ? Date.now() : Math.min(...lists.map((l) => l.syncedAt)),
      complete: lists.every((l) => l.complete),
      categories: [...categories.values()],
      items: [...entries.values()],
    } as ListOf<K>;
  }

  /** Titre conservé, ou en cours de lecture au tout premier chargement. */
  private storedItem<K extends VodKind>(portalId: string, kind: K, id: string): VodItemOf[K] | null {
    const stored = this.deps.store.item(portalId, kind, id);
    if (stored !== null) return stored;
    const items = (this.progress.get(`${portalId}:${kind}`)?.items ?? []) as VodItemOf[K][];
    return items.find((i) => i.id === id) ?? null;
  }

  /** Film avec sa commande de lecture : réservé au serveur. */
  async movie(portalId: string, movieId: string): Promise<StoredMovie> {
    await this.ensure(portalId, 'movie');
    const movie = this.storedItem(portalId, 'movie', movieId);
    if (movie === null) throw notFound('film');
    return movie;
  }

  async movieDetail(portalId: string, movieId: string): Promise<MovieDetailDto> {
    const m = await this.movie(portalId, movieId);
    return {
      ...movieSummary(portalId, m),
      originalName: m.originalName,
      description: m.description,
      director: m.director,
      actors: m.actors,
    };
  }

  /** Affiche telle que conservée (chemin du portail ou URL d'un tiers). */
  async poster(portalId: string, kind: VodKind, id: string): Promise<string | null> {
    await this.ensure(portalId, kind);
    return this.storedItem(portalId, kind, id)?.poster ?? null;
  }

  private async storedSeries(portalId: string, seriesId: string): Promise<StoredSeries> {
    await this.ensure(portalId, 'series');
    const s = this.storedItem(portalId, 'series', seriesId);
    if (s === null) throw notFound('série');
    return s;
  }

  async seriesDetail(portalId: string, seriesId: string): Promise<SeriesDetailDto> {
    const s = await this.storedSeries(portalId, seriesId);
    const seasons = await this.cached(`s:${portalId}:${seriesId}`, () =>
      this.deps.registry.get(portalId).provider.client.getSeasons(seriesId),
    );
    return {
      ...seriesSummary(portalId, s),
      description: s.description,
      seasons: seasons
        .map((x: StalkerSeason) => ({
          id: x.id,
          number: x.number,
          name: x.name,
          episodeCount: x.episodeCount,
        }))
        .sort((a, b) => a.number - b.number),
    };
  }

  /** Épisodes d'une saison, commandes de lecture comprises : réservé au serveur. */
  async episodesOf(portalId: string, seriesId: string, seasonId: string): Promise<StalkerEpisode[]> {
    await this.storedSeries(portalId, seriesId);
    return this.cached(`e:${portalId}:${seriesId}:${seasonId}`, () =>
      this.deps.registry.get(portalId).provider.client.getEpisodes(seriesId, seasonId),
    );
  }

  async episodes(portalId: string, seriesId: string, seasonId: string): Promise<EpisodeDto[]> {
    const list = await this.episodesOf(portalId, seriesId, seasonId);
    return list
      .map((e) => ({ id: e.id, number: e.number, name: e.name }))
      .sort((a, b) => a.number - b.number);
  }

  async episode(
    portalId: string,
    seriesId: string,
    seasonId: string,
    episodeId: string,
  ): Promise<StalkerEpisode> {
    const found = (await this.episodesOf(portalId, seriesId, seasonId)).find((e) => e.id === episodeId);
    if (found === undefined) throw notFound('épisode');
    return found;
  }

  /** Mémoire bornée et datée ; un échec n'est pas retenu (le portail a pu se rétablir). */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.seriesCache.get(key);
    if (hit !== undefined && now - hit.at <= this.options.seriesCacheTtlMs) return hit.value as Promise<T>;
    const value = load();
    value.catch(() => {
      if (this.seriesCache.get(key)?.value === value) this.seriesCache.delete(key);
    });
    this.seriesCache.delete(key);
    this.seriesCache.set(key, { at: now, value });
    for (const old of this.seriesCache.keys()) {
      if (this.seriesCache.size <= SERIES_CACHE_MAX_ENTRIES) break;
      this.seriesCache.delete(old);
    }
    return value;
  }

  forget(portalId: string): void {
    for (const key of [...this.memo.keys()]) if (key.startsWith(`${portalId}:`)) this.memo.delete(key);
  }
}

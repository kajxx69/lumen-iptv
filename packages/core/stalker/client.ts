import type { StreamFormat } from '../sources/index.js';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  DEFAULT_TUNING,
  DEVICE_PROFILES,
  type DeviceProfile,
  type DeviceProfileName,
  type StalkerTuning,
} from './config.js';
import { type PortalLocation, locatePortal } from './endpoint.js';
import { StalkerError, type StalkerErrorKind, asStalkerError } from './errors.js';
import { detectStreamFormat, redactUrl, stripCmdPrefix } from './links.js';
import { collectPages, paginate } from './pagination.js';
import {
  type Page,
  type StalkerAccountInfo,
  type StalkerChannel,
  type StalkerDataTableRow,
  type StalkerEpisode,
  type StalkerGenre,
  type StalkerMovie,
  type StalkerProfile,
  type StalkerProgramme,
  type StalkerRadio,
  type StalkerSeason,
  type StalkerSeries,
  parseAccountInfo,
  parseChannel,
  parseDataTableRow,
  parseEpgInfo,
  parseEpisode,
  parseGenres,
  parseHandshake,
  parseIdList,
  parseLink,
  parseList,
  parseMovie,
  parsePage,
  parseProfile,
  parseProgramme,
  parseRadio,
  parseSeason,
  parseSeries,
} from './parse.js';
import { RateLimiter } from './rate-limiter.js';
import { type Logger, type Runtime, noopLogger, sleep } from './runtime.js';
import { type DeviceIdentity, type QueryParams, Transport, interpret, stalkerHeaders } from './transport.js';

export interface StalkerCredentials {
  login: string;
  password: string;
}

export interface StalkerClientOptions {
  /** URL donnée par le fournisseur pour un boîtier MAG, ex. `http://hôte/c/`. */
  portalUrl: string;
  mac: string;
  device?: DeviceProfileName | DeviceProfile;
  /** Utilisés uniquement si le portail exige do_auth. */
  credentials?: StalkerCredentials;
  /** Point d'entrée de l'API connu d'avance : la découverte est alors sautée. */
  endpoint?: string;
  language?: string;
  timezone?: string;
  tuning?: Partial<StalkerTuning>;
  /** Identifiant repris dans chaque journal, pour suivre une session de bout en bout. */
  correlationId?: string;
}

export interface StalkerSession {
  endpoint: string;
  token: string;
  status: 'active';
  expiresAt: number | null;
  openedAt: number;
  profile: StalkerProfile;
}

/** URL de lecture éphémère : à régénérer à chaque lecture, jamais à mettre en cache. */
export interface ResolvedLink {
  url: string;
  format: StreamFormat;
  resolvedAt: number;
}

export interface TimeRange {
  from: number;
  to: number;
}

export type ChannelListStrategy = 'auto' | 'all' | 'paged';

const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
const DAY_MS = 86_400_000;
const PROFILE_STATUS_ACTIVE = 0;
const PROFILE_STATUS_AUTH_REQUIRED = 2;
/** Échecs de get_all_channels qui justifient de passer à la pagination plutôt que d'abandonner. */
const ALL_CHANNELS_FALLBACK: ReadonlySet<StalkerErrorKind> = new Set(['invalid_response', 'http', 'timeout']);

const pad = (n: number): string => String(n).padStart(2, '0');
const isoDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const stalkerDateTime = (ms: number): string => {
  const d = new Date(ms);
  return `${isoDay(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/**
 * Client complet du middleware Stalker. Ne dépend que du `Runtime` injecté.
 *
 * Toute méthode publique ouvre la session si besoin, renouvelle le token sur 401/403
 * (une seule fois pour tous les appels concurrents) et relance les erreurs passagères
 * avec un recul exponentiel. Un bannissement (429) n'est jamais relancé.
 */
export class StalkerClient {
  private readonly tuning: StalkerTuning;
  private readonly identity: DeviceIdentity;
  private readonly location: PortalLocation;
  private readonly transport: Transport;
  private readonly log: Logger;
  private readonly logContext: Record<string, unknown>;
  private endpoint: string | null;
  private current: StalkerSession | null = null;
  private opening: Promise<StalkerSession> | null = null;
  private cancelKeepAlive: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly options: StalkerClientOptions,
    private readonly runtime: Runtime,
  ) {
    if (!MAC_PATTERN.test(options.mac)) throw new StalkerError('invalid_config', 'adresse MAC invalide');
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
    const device =
      typeof options.device === 'object' ? options.device : DEVICE_PROFILES[options.device ?? 'MAG250'];
    this.identity = {
      mac: options.mac.toUpperCase(),
      device,
      language: options.language ?? DEFAULT_LANGUAGE,
      timezone: options.timezone ?? DEFAULT_TIMEZONE,
    };
    this.location = locatePortal(options.portalUrl);
    this.endpoint = options.endpoint ?? null;
    this.transport = new Transport(
      runtime,
      new RateLimiter(this.tuning.rateLimitPerSecond, runtime),
      this.tuning,
    );
    this.log = runtime.logger ?? noopLogger;
    this.logContext = { cid: options.correlationId ?? null, device: device.model };
  }

  get session(): StalkerSession | null {
    return this.current;
  }

  /** Ouvre (ou rouvre) la session : découverte, handshake, get_profile, do_auth si exigé. */
  authenticate(): Promise<StalkerSession> {
    this.opening ??= this.openSession().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** Arrête le maintien de session. Le client reste utilisable pour des appels ponctuels. */
  close(): void {
    this.closed = true;
    this.cancelKeepAlive?.();
    this.cancelKeepAlive = null;
  }

  // --- Session ---

  private headers(token: string | null): Record<string, string> {
    return stalkerHeaders(this.identity, this.location.referer, token);
  }

  private backoff(attempt: number): number {
    const raw = Math.min(this.tuning.retryMaxDelayMs, this.tuning.retryBaseDelayMs * 2 ** attempt);
    const jitter = 1 + this.tuning.retryJitterRatio * (2 * this.runtime.random() - 1);
    return Math.round(raw * jitter);
  }

  /** Relance les erreurs passagères. Pendant l'ouverture, un 401/403 compte comme passager. */
  private async withRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await attempt();
      } catch (err) {
        const error = asStalkerError(err);
        if (!error.retryable || n >= this.tuning.retryAttempts) throw error;
        this.log.debug({ ...this.logContext, action: label, kind: error.kind, attempt: n + 1 }, 'relance');
        await sleep(this.runtime, this.backoff(n));
      }
    }
  }

  private handshakeParams(): QueryParams {
    return { type: 'stb', action: 'handshake', token: '', prehash: 0 };
  }

  private profileParams(): QueryParams {
    return {
      type: 'stb',
      action: 'get_profile',
      hd: 1,
      ver: this.identity.device.firmware,
      stb_type: this.identity.device.model,
      num_banks: 2,
      not_valid_token: 0,
    };
  }

  /** Un refus persistant pendant l'ouverture signifie que le portail rejette cet appareil. */
  private asOpeningError(err: unknown): StalkerError {
    const error = asStalkerError(err);
    if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
      return new StalkerError('device_rejected', 'le portail refuse cet appareil (MAC, modèle ou en-têtes)', {
        ...(error.status === null ? {} : { status: error.status }),
        cause: error,
      });
    }
    return error;
  }

  private async handshake(endpoint: string): Promise<string> {
    try {
      return await this.withRetry('handshake', async () =>
        parseHandshake(await this.transport.send(endpoint, this.handshakeParams(), this.headers(null))),
      );
    } catch (err) {
      throw this.asOpeningError(err);
    }
  }

  /**
   * Essaie les emplacements connus de l'API. Un emplacement qui répond en JSON, même
   * par un refus, est un portail Stalker : on s'y arrête.
   */
  private async discover(): Promise<{ endpoint: string; token: string }> {
    const tried: string[] = [];
    let lastNetworkError: StalkerError | null = null;
    let networkFailures = 0;
    for (const candidate of this.location.candidates) {
      tried.push(candidate);
      let res;
      try {
        res = await this.transport.request(candidate, this.handshakeParams(), this.headers(null));
      } catch (err) {
        lastNetworkError = asStalkerError(err);
        networkFailures++;
        continue;
      }
      let isJson = true;
      try {
        JSON.parse(res.body);
      } catch {
        isJson = false;
      }
      if (!isJson) continue;
      if (res.status === 200) {
        try {
          return { endpoint: candidate, token: parseHandshake(interpret(res, 'handshake')) };
        } catch {
          continue;
        }
      }
      if (res.status === 429) interpret(res, 'handshake');
      if (res.status === 401 || res.status === 403) {
        return { endpoint: candidate, token: await this.handshake(candidate) };
      }
    }
    // Tous les essais en échec réseau : c'est le portail qui est injoignable, pas l'URL qui est fausse.
    if (lastNetworkError !== null && networkFailures === tried.length) throw lastNetworkError;
    throw new StalkerError('endpoint_not_found', 'aucun point d’entrée Stalker trouvé pour cette URL', {
      details: { tried },
    });
  }

  private async openSession(): Promise<StalkerSession> {
    let endpoint = this.endpoint;
    let token: string;
    if (endpoint === null) {
      const found = await this.discover();
      endpoint = found.endpoint;
      token = found.token;
      this.log.info({ ...this.logContext, endpoint: redactUrl(endpoint) }, 'point d’entrée découvert');
    } else {
      token = await this.handshake(endpoint);
    }
    this.endpoint = endpoint;
    const fetchProfile = async (): Promise<StalkerProfile> => {
      try {
        return parseProfile(
          await this.withRetry('get_profile', () =>
            this.transport.send(endpoint, this.profileParams(), this.headers(token)),
          ),
        );
      } catch (err) {
        throw this.asOpeningError(err);
      }
    };

    let profile = await fetchProfile();
    if (profile.status !== PROFILE_STATUS_ACTIVE) {
      const credentials = this.options.credentials;
      if (credentials === undefined) {
        throw profile.status === PROFILE_STATUS_AUTH_REQUIRED
          ? new StalkerError('auth_required', 'le portail exige un identifiant et un mot de passe')
          : new StalkerError('account_inactive', `compte inactif (statut ${profile.status})`);
      }
      const accepted = await this.withRetry('do_auth', () =>
        this.transport.send(
          endpoint,
          {
            type: 'stb',
            action: 'do_auth',
            login: credentials.login,
            password: credentials.password,
            device_id: '',
            device_id2: '',
          },
          this.headers(token),
        ),
      );
      if (accepted !== true && accepted !== 1 && accepted !== '1') {
        throw new StalkerError('auth_failed', 'identifiant ou mot de passe refusé par le portail');
      }
      profile = await fetchProfile();
      if (profile.status !== PROFILE_STATUS_ACTIVE) {
        throw new StalkerError(
          'account_inactive',
          `compte inactif après authentification (statut ${profile.status})`,
        );
      }
    }

    const session: StalkerSession = {
      endpoint,
      token,
      status: 'active',
      expiresAt: profile.expiresAt,
      openedAt: this.runtime.now(),
      profile,
    };
    this.current = session;
    this.log.info(
      { ...this.logContext, endpoint: redactUrl(endpoint), expiresAt: profile.expiresAt },
      'session ouverte',
    );
    this.scheduleKeepAlive();
    return session;
  }

  private ensureSession(): Promise<StalkerSession> {
    return this.current === null ? this.authenticate() : Promise.resolve(this.current);
  }

  /** Renouvellement à vol unique : les appels concurrents partagent le même handshake. */
  private renew(staleToken: string): Promise<StalkerSession> {
    if (this.current !== null && this.current.token !== staleToken) return Promise.resolve(this.current);
    if (this.opening === null) this.log.warn(this.logContext, 'token refusé, renouvellement de la session');
    return this.authenticate();
  }

  private scheduleKeepAlive(): void {
    if (this.closed || this.cancelKeepAlive !== null) return;
    this.cancelKeepAlive = this.runtime.setTimer(() => {
      this.cancelKeepAlive = null;
      void this.keepAlive();
    }, this.tuning.keepAliveIntervalMs);
  }

  private async keepAlive(): Promise<void> {
    if (this.closed) return;
    try {
      await this.getProfile();
    } catch (err) {
      this.log.warn({ ...this.logContext, kind: asStalkerError(err).kind }, 'maintien de session en échec');
    }
    this.scheduleKeepAlive();
  }

  /** Appel authentifié avec renouvellement et relances. Renvoie le contenu `js`. */
  async call(type: string, action: string, params: QueryParams = {}): Promise<unknown> {
    let session = await this.ensureSession();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transport.send(
          session.endpoint,
          { type, action, ...params },
          this.headers(session.token),
        );
      } catch (err) {
        const error = asStalkerError(err);
        if (!error.retryable || attempt >= this.tuning.retryAttempts) {
          this.log.warn(
            { ...this.logContext, type, action, kind: error.kind, status: error.status },
            'appel en échec',
          );
          throw error;
        }
        if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
          session = await this.renew(session.token);
        } else {
          this.log.debug(
            { ...this.logContext, type, action, kind: error.kind, attempt: attempt + 1 },
            'relance',
          );
          await sleep(this.runtime, this.backoff(attempt));
        }
      }
    }
  }

  private paginationOptions(startPage?: number): {
    startPage?: number;
    tuning: StalkerTuning;
    timers: Runtime;
  } {
    return { ...(startPage === undefined ? {} : { startPage }), tuning: this.tuning, timers: this.runtime };
  }

  private async link(type: string, cmd: string, action = 'create_link'): Promise<ResolvedLink> {
    const body = await this.call(type, action, {
      cmd,
      series: '',
      forced_storage: 'undefined',
      disable_ad: 0,
      download: 0,
    });
    const { cmd: raw, error } = parseLink(body);
    if (error !== '' || raw.trim() === '') {
      throw new StalkerError('nothing_to_play', 'le portail n’a rien à lire pour cette référence', {
        details: { portalError: error },
      });
    }
    const url = stripCmdPrefix(raw);
    return { url, format: detectStreamFormat(url), resolvedAt: this.runtime.now() };
  }

  // --- Compte ---

  async getProfile(): Promise<StalkerProfile> {
    const { type, action, ...rest } = this.profileParams();
    return parseProfile(await this.call(String(type), String(action), rest));
  }

  async getAccountInfo(): Promise<StalkerAccountInfo> {
    return parseAccountInfo(await this.call('stb', 'get_account_info'));
  }

  async getMainInfo(): Promise<StalkerAccountInfo> {
    return parseAccountInfo(await this.call('account_info', 'get_main_info'));
  }

  // --- TV ---

  async getGenres(): Promise<StalkerGenre[]> {
    return parseGenres(await this.call('itv', 'get_genres'));
  }

  async getAllChannels(): Promise<StalkerChannel[]> {
    return parsePage(await this.call('itv', 'get_all_channels'), parseChannel).items;
  }

  async getOrderedList(
    opts: { genre?: string; page?: number; sortBy?: 'number' | 'name'; favoritesOnly?: boolean } = {},
  ): Promise<Page<StalkerChannel>> {
    const body = await this.call('itv', 'get_ordered_list', {
      genre: opts.genre ?? '*',
      p: opts.page ?? 1,
      sortby: opts.sortBy ?? 'number',
      fav: opts.favoritesOnly ?? false,
    });
    return parsePage(body, parseChannel);
  }

  /**
   * Toutes les chaînes. `auto` tente get_all_channels (une requête) puis se rabat sur la
   * pagination si le portail l'a désactivé ou n'y répond pas.
   */
  async *listChannels(
    opts: { genre?: string; startPage?: number; strategy?: ChannelListStrategy } = {},
  ): AsyncGenerator<StalkerChannel> {
    const strategy = opts.strategy ?? 'auto';
    const wholeCatalogue = (opts.genre === undefined || opts.genre === '*') && opts.startPage === undefined;
    if (strategy === 'all' || (strategy === 'auto' && wholeCatalogue)) {
      try {
        const all = await this.getAllChannels();
        if (all.length > 0 || strategy === 'all') {
          yield* all;
          return;
        }
      } catch (err) {
        const error = asStalkerError(err);
        if (strategy === 'all' || !ALL_CHANNELS_FALLBACK.has(error.kind)) throw error;
        this.log.info({ ...this.logContext, kind: error.kind }, 'get_all_channels indisponible, pagination');
      }
    }
    const genre = opts.genre ?? '*';
    yield* paginate((page) => this.getOrderedList({ genre, page }), this.paginationOptions(opts.startPage));
  }

  /** Nouveau lien à chaque appel : l'URL est liée au token et expire vite. */
  createLink(cmd: string): Promise<ResolvedLink> {
    return this.link('itv', cmd);
  }

  /** Ancien nom de create_link sur certains middlewares. */
  getLink(cmd: string): Promise<ResolvedLink> {
    return this.link('itv', cmd, 'get_link');
  }

  // --- EPG ---

  async getShortEpg(channelId: string, size = 10): Promise<StalkerProgramme[]> {
    return parseList(await this.call('itv', 'get_short_epg', { ch_id: channelId, size }), parseProgramme)
      .items;
  }

  async getEpgInfo(periodHours: number): Promise<Map<string, StalkerProgramme[]>> {
    return parseEpgInfo(await this.call('itv', 'get_epg_info', { period: periodHours }));
  }

  async getDataTable(opts: {
    page?: number;
    from: number;
    to: number;
    favoritesOnly?: boolean;
    channelId?: string;
  }): Promise<Page<StalkerDataTableRow>> {
    const body = await this.call('epg', 'get_data_table', {
      from: stalkerDateTime(opts.from),
      to: stalkerDateTime(opts.to),
      fav: opts.favoritesOnly ?? false,
      p: opts.page ?? 1,
      ...(opts.channelId === undefined ? {} : { ch_id: opts.channelId }),
    });
    return parsePage(body, parseDataTableRow);
  }

  async getSimpleDataTable(channelId: string, day: string, page = 1): Promise<Page<StalkerProgramme>> {
    return parsePage(
      await this.call('epg', 'get_simple_data_table', { ch_id: channelId, date: day, p: page }),
      parseProgramme,
    );
  }

  /** Programmes d'une chaîne recoupant la fenêtre, jour par jour, sans doublon. */
  async getEpg(channelId: string, range: TimeRange): Promise<StalkerProgramme[]> {
    const byId = new Map<string, StalkerProgramme>();
    for (let day = Math.floor(range.from / DAY_MS); day * DAY_MS < range.to; day++) {
      const programmes = await collectPages(
        (page) => this.getSimpleDataTable(channelId, isoDay(day * DAY_MS), page),
        this.paginationOptions(),
      );
      for (const p of programmes) {
        if (p.end > range.from && p.start < range.to)
          byId.set(p.id, p.channelId === '' ? { ...p, channelId } : p);
      }
    }
    return [...byId.values()].sort((a, b) => a.start - b.start);
  }

  // --- VOD ---

  async getVodCategories(): Promise<StalkerGenre[]> {
    return parseGenres(await this.call('vod', 'get_categories'));
  }

  async getVodPage(
    opts: { category?: string; page?: number; search?: string } = {},
  ): Promise<Page<StalkerMovie>> {
    const body = await this.call('vod', 'get_ordered_list', {
      category: opts.category ?? '*',
      p: opts.page ?? 1,
      sortby: 'added',
      ...(opts.search === undefined ? {} : { search: opts.search }),
    });
    return parsePage(body, parseMovie);
  }

  listVod(
    opts: { category?: string; search?: string; startPage?: number } = {},
  ): AsyncGenerator<StalkerMovie> {
    return paginate((page) => this.getVodPage({ ...opts, page }), this.paginationOptions(opts.startPage));
  }

  createVodLink(cmd: string): Promise<ResolvedLink> {
    return this.link('vod', cmd);
  }

  // --- Séries ---

  async getSeriesCategories(): Promise<StalkerGenre[]> {
    return parseGenres(await this.call('series', 'get_categories'));
  }

  async getSeriesPage(
    opts: { category?: string; page?: number; search?: string } = {},
  ): Promise<Page<StalkerSeries>> {
    const body = await this.call('series', 'get_ordered_list', {
      category: opts.category ?? '*',
      p: opts.page ?? 1,
      ...(opts.search === undefined ? {} : { search: opts.search }),
    });
    return parsePage(body, parseSeries);
  }

  listSeries(
    opts: { category?: string; search?: string; startPage?: number } = {},
  ): AsyncGenerator<StalkerSeries> {
    return paginate((page) => this.getSeriesPage({ ...opts, page }), this.paginationOptions(opts.startPage));
  }

  getSeasons(seriesId: string): Promise<StalkerSeason[]> {
    return collectPages(
      async (page) =>
        parsePage(
          await this.call('series', 'get_ordered_list', {
            movie_id: seriesId,
            season_id: 0,
            episode_id: 0,
            p: page,
          }),
          parseSeason,
        ),
      this.paginationOptions(),
    );
  }

  getEpisodes(seriesId: string, seasonId: string): Promise<StalkerEpisode[]> {
    return collectPages(
      async (page) =>
        parsePage(
          await this.call('series', 'get_ordered_list', {
            movie_id: seriesId,
            season_id: seasonId,
            episode_id: 0,
            p: page,
          }),
          parseEpisode,
        ),
      this.paginationOptions(),
    );
  }

  createEpisodeLink(cmd: string): Promise<ResolvedLink> {
    return this.link('series', cmd);
  }

  // --- Radio ---

  async getRadioGenres(): Promise<StalkerGenre[]> {
    return parseGenres(await this.call('radio', 'get_genres'));
  }

  listRadio(opts: { genre?: string; startPage?: number } = {}): AsyncGenerator<StalkerRadio> {
    return paginate(
      async (page) =>
        parsePage(
          await this.call('radio', 'get_ordered_list', { genre: opts.genre ?? '*', p: page }),
          parseRadio,
        ),
      this.paginationOptions(opts.startPage),
    );
  }

  createRadioLink(cmd: string): Promise<ResolvedLink> {
    return this.link('radio', cmd);
  }

  // --- Archive ---

  /** `cmd` horodaté issu de l'EPG (programme marqué archivé). */
  createArchiveLink(cmd: string): Promise<ResolvedLink> {
    return this.link('tv_archive', cmd);
  }

  // --- Favoris ---

  async getFavoriteIds(): Promise<string[]> {
    return parseIdList(await this.call('itv', 'get_fav_ids'));
  }

  async setFavorites(channelIds: readonly string[]): Promise<void> {
    await this.call('itv', 'set_fav', { fav_ch: channelIds.join(',') });
  }

  listFavorites(opts: { startPage?: number } = {}): AsyncGenerator<StalkerChannel> {
    return paginate(
      async (page) => parsePage(await this.call('itv', 'get_fav_items', { p: page }), parseChannel),
      this.paginationOptions(opts.startPage),
    );
  }
}

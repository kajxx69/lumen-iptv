import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChaosController } from '../chaos/controller.js';
import { type Clock, sleep } from '../clock.js';
import type { FakePortalConfig } from '../config.js';
import { archiveStreamId } from '../media/stream-routes.js';
import type { Catalog, Channel, Genre, Programme } from './catalog.js';
import type { PlayKind, Session, SessionStore } from './sessions.js';

export interface ApiDeps {
  config: FakePortalConfig;
  clock: Clock;
  chaos: ChaosController;
  sessions: SessionStore;
  catalog: Catalog;
}

type Query = Record<string, string | undefined>;
type Json = unknown;

interface Result {
  status: number;
  body: Json;
}

interface Context {
  q: Query;
  session: Session;
  baseUrl: string;
  now: number;
}

const STALKER_CONTENT_TYPE = 'text/javascript; charset=UTF-8';
const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
const MODEL_PATTERN = /Model:\s*(MAG\d+)/i;
const DEFAULT_EPG_SIZE = 10;
const DEFAULT_EPG_PERIOD_HOURS = 6;
const ACCOUNT_VALIDITY_MS = 30 * 86_400_000;
const WATCHDOG_TIMEOUT_S = 120;

const ok = (js: Json): Result => ({ status: 200, body: { js } });
const fail = (status: number, text: string): Result => ({ status, body: { js: [], text } });
/** Erreur métier Stalker : réponse 200 avec un champ error, comme les vrais portails. */
const nothingToPlay = (): Result => ok({ id: null, cmd: '', error: 'nothing_to_play' });

const pad = (n: number): string => String(n).padStart(2, '0');
/** Les portails expriment les dates dans leur fuseau ; on sert Africa/Abidjan, soit UTC. */
function stalkerDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const hhmm = (ms: number): string => stalkerDate(ms).slice(11, 16);

function parseStalkerTime(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? fallback : ms;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      out.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
    } catch {
      out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }
  return out;
}

export function registerStalkerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { config, clock, chaos, sessions, catalog } = deps;
  const n = (v: number): number | string => (config.stringNumbers ? String(v) : v);
  const flag = (b: boolean): number | string => n(b ? 1 : 0);

  function page<T>(items: readonly T[], q: Query, map: (item: T) => Json): Json {
    const p = Math.max(1, Number.parseInt(q['p'] ?? '1', 10) || 1);
    const slice = items.slice((p - 1) * config.pageSize, p * config.pageSize);
    return {
      total_items: n(items.length),
      max_page_items: n(config.pageSize),
      selected_item: n(0),
      cur_page: n(p),
      data: slice.map(map),
    };
  }

  const genreJson = (g: Genre): Json => ({
    id: g.id,
    title: g.title,
    alias: g.alias,
    censored: flag(g.censored),
  });
  const allGenre = (title: string): Json => ({ id: '*', title, alias: '*', censored: flag(false) });

  function channelJson(c: Channel, ctx: Context): Json {
    const favs = sessions.favoritesOf(ctx.session.mac);
    return {
      id: n(c.id),
      name: c.name,
      number: n(c.number),
      cmd: `ffmpeg http://localhost/ch/${c.id}_`,
      tv_genre_id: c.genreId,
      logo: c.logoPath === '' ? '' : `${ctx.baseUrl}${c.logoPath}`,
      xmltv_id: c.xmltvId,
      censored: flag(c.censored),
      tv_archive: flag(c.archiveDays > 0),
      tv_archive_duration: n(c.archiveDays * 24),
      use_http_tmp_link: n(1),
      fav: flag(favs.includes(c.id)),
      status: n(1),
    };
  }

  function programmeJson(p: Programme, c: Channel, now: number): Json {
    const archivable = c.archiveDays > 0 && p.endMs <= now && p.startMs >= now - c.archiveDays * 86_400_000;
    return {
      id: p.id,
      ch_id: n(c.id),
      time: stalkerDate(p.startMs),
      time_to: stalkerDate(p.endMs),
      duration: n((p.endMs - p.startMs) / 1000),
      name: p.name,
      descr: p.description,
      category: p.category,
      real_id: p.id,
      start_timestamp: n(p.startMs / 1000),
      stop_timestamp: n(p.endMs / 1000),
      t_time: hhmm(p.startMs),
      t_time_to: hhmm(p.endMs),
      mark_archive: flag(archivable),
      cmd: archivable ? `auto /media/${p.id}.mpg` : '',
    };
  }

  function playUrl(ctx: Context, kind: PlayKind, streamId: string, path: string, extra: string): string {
    const grant = sessions.grantPlay(ctx.session, kind, streamId);
    const mac = encodeURIComponent(ctx.session.mac);
    return `${ctx.baseUrl}${path}?mac=${mac}&stream=${encodeURIComponent(streamId)}${extra}&play_token=${grant.token}`;
  }

  function channelFromCmd(cmd: string | undefined): Channel | undefined {
    const m = /\/ch\/(\d+)/.exec(cmd ?? '');
    return m?.[1] === undefined ? undefined : catalog.channelById.get(Number(m[1]));
  }

  let nextLinkId = 1;
  function liveLink(ctx: Context, streamId: string, prefix: string): Json {
    const url = playUrl(ctx, 'live', streamId, '/play/live.php', `&extension=${config.streamFormat}`);
    return {
      id: streamId,
      cmd: `${prefix}${url}`,
      streamer_id: n(0),
      link_id: n(nextLinkId++),
      load: n(0),
      error: '',
    };
  }

  const profile = (ctx: Context): Json => ({
    id: n(1),
    name: 'Compte de test',
    login: config.requireDoAuth ? config.login : '',
    mac: ctx.session.mac,
    status: n(ctx.session.authenticated ? 0 : 2),
    stb_type: ctx.session.model,
    locale: 'fr_FR',
    default_timezone: 'Africa/Abidjan',
    expire_billing_date: stalkerDate(ctx.now + ACCOUNT_VALIDITY_MS),
    tariff_plan_id: n(1),
    watchdog_timeout: n(WATCHDOG_TIMEOUT_S),
    allowed_stb_types: config.allowedModels.map((m) => m.toLowerCase()),
    enable_tv_archive: n(1),
    storages: {},
    playback_limit: n(0),
    aspect: n(16),
  });

  const accountInfo = (ctx: Context): Json => ({
    mac: ctx.session.mac,
    phone: '',
    fname: 'Compte de test',
    tariff_plan: 'Test',
    end_date: stalkerDate(ctx.now + ACCOUNT_VALIDITY_MS),
  });

  function epgDataTable(ctx: Context): Json {
    const from = parseStalkerTime(ctx.q['from'], ctx.now);
    const to = parseStalkerTime(ctx.q['to'], from + DEFAULT_EPG_PERIOD_HOURS * 3_600_000);
    let channels: readonly Channel[] = catalog.channels;
    if (ctx.q['fav'] === '1') {
      const favs = new Set(sessions.favoritesOf(ctx.session.mac));
      channels = channels.filter((c) => favs.has(c.id));
    }
    return page(channels, ctx.q, (c) => ({
      ch_id: n(c.id),
      name: c.name,
      number: n(c.number),
      epg: catalog.programmesBetween(c, from, to).map((p) => programmeJson(p, c, ctx.now)),
    }));
  }

  function simpleDataTable(ctx: Context): Result {
    const c = catalog.channelById.get(Number(ctx.q['ch_id']));
    if (c === undefined) return ok({ total_items: n(0), max_page_items: n(config.pageSize), data: [] });
    const dayStart = parseStalkerTime(
      ctx.q['date'] === undefined ? undefined : `${ctx.q['date']} 00:00:00`,
      ctx.now - (ctx.now % 86_400_000),
    );
    return ok(
      page(catalog.programmesBetween(c, dayStart, dayStart + 86_400_000), ctx.q, (p) =>
        programmeJson(p, c, ctx.now),
      ),
    );
  }

  function orderedChannels(ctx: Context): Channel[] {
    const genre = ctx.q['genre'];
    let list =
      genre === undefined || genre === '*' || genre === ''
        ? catalog.channels
        : catalog.channels.filter((c) => c.genreId === genre);
    if (ctx.q['fav'] === '1') {
      const favs = new Set(sessions.favoritesOf(ctx.session.mac));
      list = list.filter((c) => favs.has(c.id));
    }
    return ctx.q['sortby'] === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list;
  }

  function searchFilter<T extends { name: string }>(items: readonly T[], q: Query): readonly T[] {
    const term = (q['search'] ?? '').trim().toLowerCase();
    return term === '' ? items : items.filter((i) => i.name.toLowerCase().includes(term));
  }

  const handlers: Record<string, Record<string, (ctx: Context) => Result>> = {
    stb: {
      get_profile: (ctx) => ok(profile(ctx)),
      do_auth: (ctx) => {
        const valid = ctx.q['login'] === config.login && ctx.q['password'] === config.password;
        if (valid) ctx.session.authenticated = true;
        return ok(valid);
      },
      get_account_info: (ctx) => ok(accountInfo(ctx)),
      get_localization: () => ok({}),
      log: () => ok(true),
    },
    account_info: {
      get_main_info: (ctx) => ok(accountInfo(ctx)),
      get_account_info: (ctx) => ok(accountInfo(ctx)),
    },
    watchdog: {
      get_events: () => ok({ data: { msgs: n(0), id: n(0), event: '', need_confirm: n(0), msg: '' } }),
    },
    itv: {
      get_genres: () => ok([allGenre('Tout'), ...catalog.genres.map(genreJson)]),
      get_all_channels: (ctx) =>
        ok({
          total_items: n(catalog.channels.length),
          max_page_items: n(catalog.channels.length),
          data: catalog.channels.map((c) => channelJson(c, ctx)),
        }),
      get_ordered_list: (ctx) => ok(page(orderedChannels(ctx), ctx.q, (c) => channelJson(c, ctx))),
      create_link: (ctx) => {
        const c = channelFromCmd(ctx.q['cmd']);
        return c === undefined ? nothingToPlay() : ok(liveLink(ctx, String(c.id), c.linkPrefix));
      },
      // Ancien nom de create_link sur certains middlewares.
      get_link: (ctx) => {
        const c = channelFromCmd(ctx.q['cmd']);
        return c === undefined ? nothingToPlay() : ok(liveLink(ctx, String(c.id), c.linkPrefix));
      },
      get_short_epg: (ctx) => {
        const c = catalog.channelById.get(Number(ctx.q['ch_id']));
        if (c === undefined) return ok([]);
        const size = Number.parseInt(ctx.q['size'] ?? '', 10) || DEFAULT_EPG_SIZE;
        return ok(catalog.nextProgrammes(c, ctx.now, size).map((p) => programmeJson(p, c, ctx.now)));
      },
      get_epg_info: (ctx) => {
        const hours = Number.parseInt(ctx.q['period'] ?? '', 10) || DEFAULT_EPG_PERIOD_HOURS;
        const data: Record<string, Json> = {};
        for (const c of catalog.channels) {
          data[String(c.id)] = catalog
            .programmesBetween(c, ctx.now, ctx.now + hours * 3_600_000)
            .map((p) => programmeJson(p, c, ctx.now));
        }
        return ok({ data });
      },
      get_data_table: (ctx) => ok(epgDataTable(ctx)),
      get_fav_ids: (ctx) => ok(sessions.favoritesOf(ctx.session.mac).map(n)),
      get_fav_items: (ctx) => {
        const favs = sessions.favoritesOf(ctx.session.mac);
        const channels = favs.flatMap((id) => catalog.channelById.get(id) ?? []);
        return ok(page(channels, ctx.q, (c) => channelJson(c, ctx)));
      },
      set_fav: (ctx) => {
        const ids = (ctx.q['fav_ch'] ?? '')
          .split(',')
          .map((s) => Number.parseInt(s, 10))
          .filter((id) => catalog.channelById.has(id));
        sessions.setFavorites(ctx.session.mac, ids);
        return ok(true);
      },
    },
    epg: {
      get_data_table: (ctx) => ok(epgDataTable(ctx)),
      get_simple_data_table: simpleDataTable,
    },
    vod: {
      get_categories: () => ok([allGenre('Tout'), ...catalog.vodCategories.map(genreJson)]),
      get_ordered_list: (ctx) => {
        const cat = ctx.q['category'];
        const list =
          cat === undefined || cat === '*'
            ? catalog.movies
            : catalog.movies.filter((m) => m.categoryId === cat);
        return ok(
          page(searchFilter(list, ctx.q), ctx.q, (m) => ({
            id: n(m.id),
            name: m.name,
            o_name: m.originalName,
            description: m.description,
            year: n(m.year),
            director: m.director,
            actors: m.actors,
            rating_imdb: n(m.ratingImdb),
            time: n(m.durationMin),
            category_id: m.categoryId,
            screenshot_uri: `${ctx.baseUrl}/posters/${m.id}.png`,
            censored: flag(m.censored),
            cmd: `/media/${m.id}.mpg`,
          })),
        );
      },
      create_link: (ctx) => {
        const m = /\/media\/(\d+)\.mpg/.exec(ctx.q['cmd'] ?? '');
        const movie = m?.[1] === undefined ? undefined : catalog.movieById.get(Number(m[1]));
        if (movie === undefined) return nothingToPlay();
        const url = playUrl(ctx, 'vod', String(movie.id), '/play/movie.php', '&extension=ts');
        return ok({ id: n(movie.id), cmd: `ffmpeg ${url}`, load: n(0), error: '' });
      },
    },
    series: {
      get_categories: () => ok([allGenre('Tout'), ...catalog.seriesCategories.map(genreJson)]),
      get_ordered_list: (ctx) => {
        const seriesId = ctx.q['movie_id'];
        if (seriesId === undefined || seriesId === '') {
          const cat = ctx.q['category'];
          const list =
            cat === undefined || cat === '*'
              ? catalog.series
              : catalog.series.filter((s) => s.categoryId === cat);
          return ok(
            page(searchFilter(list, ctx.q), ctx.q, (s) => ({
              id: n(s.id),
              name: s.name,
              description: s.description,
              year: n(s.year),
              category_id: s.categoryId,
              screenshot_uri: `${ctx.baseUrl}/posters/s${s.id}.png`,
              cmd: `/series/${s.id}`,
            })),
          );
        }
        const series = catalog.seriesById.get(Number(seriesId));
        if (series === undefined) return ok(page([], ctx.q, () => null));
        const seasonId = ctx.q['season_id'];
        if (seasonId === undefined || seasonId === '' || seasonId === '0') {
          const seasons = series.episodesPerSeason.map((count, i) => ({ season: i + 1, count }));
          return ok(
            page(seasons, ctx.q, ({ season, count }) => ({
              id: `${series.id}:${season}`,
              name: `Saison ${season}`,
              is_season: true,
              series: Array.from({ length: count }, (_, i) => i + 1),
              cmd: `/series/${series.id}/${season}`,
            })),
          );
        }
        const season = Number(seasonId.includes(':') ? seasonId.split(':')[1] : seasonId);
        const count = series.episodesPerSeason[season - 1] ?? 0;
        const episodes = Array.from({ length: count }, (_, i) => i + 1);
        return ok(
          page(episodes, ctx.q, (e) => ({
            id: `${series.id}:${season}:${e}`,
            name: `Épisode ${e}`,
            series_number: n(e),
            cmd: `/media/series_${series.id}_${season}_${e}.mpg`,
          })),
        );
      },
      create_link: (ctx) => {
        const m = /\/media\/series_(\d+)_(\d+)_(\d+)\.mpg/.exec(ctx.q['cmd'] ?? '');
        if (m === null) return nothingToPlay();
        const [, sid, season, episode] = m.map(Number);
        const series = catalog.seriesById.get(sid ?? -1);
        if (
          series === undefined ||
          (series.episodesPerSeason[(season ?? 0) - 1] ?? 0) < (episode ?? Infinity)
        ) {
          return nothingToPlay();
        }
        const streamId = `series_${sid}_${season}_${episode}`;
        const url = playUrl(ctx, 'vod', streamId, '/play/movie.php', '&extension=ts');
        return ok({ id: streamId, cmd: `ffmpeg ${url}`, load: n(0), error: '' });
      },
    },
    radio: {
      get_genres: () => ok([allGenre('Tout'), ...catalog.radioGenres.map(genreJson)]),
      get_categories: () => ok([allGenre('Tout'), ...catalog.radioGenres.map(genreJson)]),
      get_ordered_list: (ctx) => {
        const genre = ctx.q['genre'];
        const list =
          genre === undefined || genre === '*'
            ? catalog.radio
            : catalog.radio.filter((r) => r.genreId === genre);
        return ok(
          page(list, ctx.q, (r) => ({
            id: n(r.id),
            name: r.name,
            number: n(r.number),
            genre_id: r.genreId,
            cmd: `ffmpeg http://localhost/radio/${r.id}`,
          })),
        );
      },
      create_link: (ctx) => {
        const m = /\/radio\/(\d+)/.exec(ctx.q['cmd'] ?? '');
        if (m?.[1] === undefined) return nothingToPlay();
        return ok(liveLink(ctx, `radio-${m[1]}`, 'ffmpeg '));
      },
    },
    tv_archive: {
      create_link: (ctx) => {
        const m = /\/media\/(\d+)_(\d+)_(\d+)\.mpg/.exec(ctx.q['cmd'] ?? '');
        if (m === null) return nothingToPlay();
        const [, chId, startSec, durationMin] = m.map(Number) as [number, number, number, number];
        const c = catalog.channelById.get(chId);
        const startMs = startSec * 1000;
        const inWindow =
          c !== undefined &&
          c.archiveDays > 0 &&
          startMs >= ctx.now - c.archiveDays * 86_400_000 &&
          startMs < ctx.now;
        if (!inWindow) return nothingToPlay();
        const streamId = archiveStreamId(String(chId), startSec, durationMin);
        const grant = sessions.grantPlay(ctx.session, 'archive', streamId);
        const url = `${ctx.baseUrl}/play/archive.php?stream=${chId}&start=${startSec}&duration=${durationMin}&play_token=${grant.token}`;
        return ok({ id: streamId, cmd: `ffmpeg ${url}`, load: n(0), error: '' });
      },
    },
  };

  async function handle(req: FastifyRequest): Promise<Result> {
    const apiLatency = chaos.latencyFor('api');
    if (apiLatency > 0) await sleep(apiLatency);
    const injected = chaos.injectedHttpError('api');
    if (injected !== null) return fail(injected, 'Injected error');

    const q = req.query as Query;
    const mac = parseCookies(req.headers.cookie).get('mac') ?? '';
    const model = MODEL_PATTERN.exec(String(req.headers['x-user-agent'] ?? ''))?.[1]?.toUpperCase();
    const userAgent = req.headers['user-agent'] ?? '';
    if (
      !MAC_PATTERN.test(mac) ||
      model === undefined ||
      !config.allowedModels.includes(model) ||
      !/MAG\d+/.test(userAgent)
    ) {
      return fail(403, 'Access denied.');
    }
    if (!sessions.admit(mac)) return fail(config.banStatusCode, 'Too many requests.');

    if (q['type'] === 'stb' && q['action'] === 'handshake') {
      const session = sessions.handshake(mac, model);
      return ok({ token: session.token, random: session.token.slice(0, 8).toLowerCase() });
    }

    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const check = bearer === undefined ? null : sessions.check(bearer, mac);
    if (check === null || !check.ok) return fail(401, 'Authorization failed.');

    const ctx: Context = {
      q,
      session: check.session,
      baseUrl: `http://${req.headers.host ?? 'localhost'}`,
      now: clock.now(),
    };
    const action = q['action'] ?? '';
    const requiresAuth = !(q['type'] === 'stb' && (action === 'get_profile' || action === 'do_auth'));
    if (requiresAuth && !check.session.authenticated) return fail(403, 'Authentication required.');

    const handler = handlers[q['type'] ?? '']?.[action];
    return handler === undefined ? fail(400, 'Unknown action.') : handler(ctx);
  }

  const route = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const result = await handle(req);
    return reply
      .code(result.status)
      .header('Content-Type', STALKER_CONTENT_TYPE)
      .send(JSON.stringify(result.body));
  };

  for (const path of config.entrypoints) {
    app.get(path, route);
    app.post(path, route);
  }
}

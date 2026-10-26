import { z } from 'zod';
import { StalkerError } from './errors.js';

/**
 * Parseur défensif : les portails « parlent » Stalker avec de nombreuses variantes
 * (nombres en chaînes, `null`, `false` à la place d'une liste, enveloppe `js` absente).
 * Chaque réponse traverse un schéma Zod qui la normalise ; une entrée isolée invalide
 * est écartée sans faire échouer la liste entière.
 */

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function looseString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function looseNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

const looseBool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** Tableau, objet indexé (`{ "0": …, "1": … }`) ou rien. */
const looseList = (v: unknown): unknown[] => (Array.isArray(v) ? v : isRecord(v) ? Object.values(v) : []);

/**
 * Champ tolérant. `prefault(null)` fait passer un champ absent par la même normalisation
 * qu'un champ `null` : sans lui, Zod laisserait `undefined` et rejetterait l'objet.
 */
const field = <T>(normalize: (v: unknown) => T): z.ZodType<T> =>
  z.unknown().transform(normalize).prefault(null);

const str = field(looseString);
const requiredStr = str.pipe(z.string().trim().min(1));
const num = (fallback = 0): z.ZodType<number> => field((v) => looseNumber(v, fallback));
const bool = field(looseBool);
/** Valeur conservée telle quelle, analysée ensuite (listes imbriquées). */
const raw = field((v): unknown => v);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Date Stalker « AAAA-MM-JJ HH:MM:SS », exprimée dans le fuseau du cookie. Le client
 * annonce Africa/Abidjan (UTC) par défaut, d'où la lecture en UTC.
 */
export function parseStalkerDate(v: unknown): number | null {
  const m = DATE_PATTERN.exec(looseString(v));
  if (m === null) return null;
  // Les secondes sont facultatives ; un groupe absent vaut 0.
  const part = (i: number): number => Number(m[i] ?? 0);
  const year = part(1);
  const month = part(2);
  const day = part(3);
  if (year === 0 || month === 0 || day === 0) return null;
  return Date.UTC(year, month - 1, day, part(4), part(5), part(6));
}

const dateField = field(parseStalkerDate);

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

export function unwrapEnvelope(body: unknown): unknown {
  return isRecord(body) && 'js' in body ? body['js'] : body;
}

export interface Page<T> {
  items: T[];
  totalItems: number;
  pageSize: number;
  /** Entrées écartées car invalides : signalées, jamais bloquantes. */
  invalidItems: number;
}

const PageEnvelope = z.object({ total_items: num(-1), max_page_items: num(0), data: raw });

export function parseList<T>(
  raw: unknown,
  parseItem: (item: unknown) => T | null,
): { items: T[]; invalid: number } {
  const items: T[] = [];
  let invalid = 0;
  for (const entry of looseList(raw)) {
    const parsed = parseItem(entry);
    if (parsed === null) invalid++;
    else items.push(parsed);
  }
  return { items, invalid };
}

export function parsePage<T>(body: unknown, parseItem: (item: unknown) => T | null): Page<T> {
  if (Array.isArray(body)) {
    const { items, invalid } = parseList(body, parseItem);
    return { items, totalItems: items.length, pageSize: items.length, invalidItems: invalid };
  }
  const envelope = PageEnvelope.parse(isRecord(body) ? body : {});
  const { items, invalid } = parseList(envelope.data, parseItem);
  return {
    items,
    totalItems: envelope.total_items >= 0 ? envelope.total_items : items.length,
    pageSize: envelope.max_page_items > 0 ? envelope.max_page_items : items.length,
    invalidItems: invalid,
  };
}

// --- Authentification et compte ---

const Handshake = z.object({ token: requiredStr });

export function parseHandshake(body: unknown): string {
  const token = parseWith(Handshake, body)?.token;
  if (token === undefined) throw new StalkerError('invalid_response', 'handshake sans token');
  return token;
}

const Profile = z
  .object({
    status: num(0),
    login: str,
    stb_type: str,
    expire_billing_date: dateField,
    end_date: dateField,
    watchdog_timeout: num(0),
  })
  .transform((r) => ({
    /** 0 = actif ; 2 = do_auth requis ; autre = compte inactif. */
    status: r.status,
    login: r.login,
    model: r.stb_type,
    expiresAt: r.expire_billing_date ?? r.end_date,
    watchdogTimeoutS: r.watchdog_timeout,
  }));

export type StalkerProfile = z.output<typeof Profile>;

export function parseProfile(body: unknown): StalkerProfile {
  return Profile.parse(isRecord(body) ? body : {});
}

const AccountInfo = z
  .object({
    mac: str,
    fname: str,
    phone: str,
    tariff_plan: str,
    end_date: dateField,
    expire_billing_date: dateField,
  })
  .transform((r) => ({
    mac: r.mac,
    fullName: r.fname,
    phone: r.phone,
    tariff: r.tariff_plan,
    expiresAt: r.end_date ?? r.expire_billing_date,
  }));

export type StalkerAccountInfo = z.output<typeof AccountInfo>;

export function parseAccountInfo(body: unknown): StalkerAccountInfo {
  return AccountInfo.parse(isRecord(body) ? body : {});
}

// --- Catalogue ---

const Genre = z
  .object({ id: requiredStr, title: str, alias: str, censored: bool })
  .transform((r) => ({ id: r.id, title: r.title, alias: r.alias, censored: r.censored }));

export type StalkerGenre = z.output<typeof Genre>;

export const parseGenre = (raw: unknown): StalkerGenre | null => parseWith(Genre, raw);
export const parseGenres = (body: unknown): StalkerGenre[] => parseList(body, parseGenre).items;

const Channel = z
  .object({
    id: requiredStr,
    name: str,
    number: num(0),
    cmd: requiredStr,
    tv_genre_id: str,
    logo: str,
    xmltv_id: str,
    tv_archive: bool,
    tv_archive_duration: num(0),
    censored: bool,
    fav: bool,
  })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    number: r.number,
    cmd: r.cmd,
    genreId: r.tv_genre_id,
    logo: r.logo,
    xmltvId: r.xmltv_id,
    archive: r.tv_archive,
    archiveHours: r.tv_archive_duration,
    censored: r.censored,
    favorite: r.fav,
  }));

export type StalkerChannel = z.output<typeof Channel>;

export const parseChannel = (raw: unknown): StalkerChannel | null => parseWith(Channel, raw);

const Programme = z
  .object({
    id: requiredStr,
    ch_id: str,
    name: str,
    descr: str,
    category: str,
    start_timestamp: num(Number.NaN),
    stop_timestamp: num(Number.NaN),
    time: dateField,
    time_to: dateField,
    duration: num(Number.NaN),
    mark_archive: bool,
    cmd: str,
  })
  .transform((r) => {
    const start = Number.isFinite(r.start_timestamp) ? r.start_timestamp * 1000 : (r.time ?? Number.NaN);
    const end = Number.isFinite(r.stop_timestamp)
      ? r.stop_timestamp * 1000
      : (r.time_to ?? (Number.isFinite(r.duration) ? start + r.duration * 1000 : Number.NaN));
    return {
      id: r.id,
      channelId: r.ch_id,
      name: r.name,
      description: r.descr,
      category: r.category,
      start,
      end,
      archived: r.mark_archive,
      cmd: r.cmd,
    };
  })
  .refine((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);

export type StalkerProgramme = z.output<typeof Programme>;

export const parseProgramme = (raw: unknown): StalkerProgramme | null => parseWith(Programme, raw);

const DataTableRow = z.object({ ch_id: requiredStr, name: str, number: num(0), epg: raw }).transform((r) => ({
  channelId: r.ch_id,
  name: r.name,
  number: r.number,
  programmes: parseList(r.epg, parseProgramme).items,
}));

export type StalkerDataTableRow = z.output<typeof DataTableRow>;

export const parseDataTableRow = (raw: unknown): StalkerDataTableRow | null => parseWith(DataTableRow, raw);

/** get_epg_info : `{ data: { <ch_id>: [programmes] } }`. */
export function parseEpgInfo(body: unknown): Map<string, StalkerProgramme[]> {
  const out = new Map<string, StalkerProgramme[]>();
  const data = isRecord(body) ? body['data'] : undefined;
  if (!isRecord(data)) return out;
  for (const [channelId, programmes] of Object.entries(data)) {
    out.set(channelId, parseList(programmes, parseProgramme).items);
  }
  return out;
}

const Movie = z
  .object({
    id: requiredStr,
    name: str,
    o_name: str,
    description: str,
    year: num(Number.NaN),
    director: str,
    actors: str,
    rating_imdb: num(Number.NaN),
    time: num(Number.NaN),
    category_id: str,
    screenshot_uri: str,
    cmd: requiredStr,
    censored: bool,
  })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    originalName: r.o_name,
    description: r.description,
    year: Number.isFinite(r.year) && r.year > 0 ? r.year : null,
    director: r.director,
    actors: r.actors,
    rating: Number.isFinite(r.rating_imdb) ? r.rating_imdb : null,
    durationMin: Number.isFinite(r.time) && r.time > 0 ? r.time : null,
    categoryId: r.category_id,
    poster: r.screenshot_uri,
    cmd: r.cmd,
    censored: r.censored,
  }));

export type StalkerMovie = z.output<typeof Movie>;

export const parseMovie = (raw: unknown): StalkerMovie | null => parseWith(Movie, raw);

const Series = z
  .object({
    id: requiredStr,
    name: str,
    description: str,
    year: num(Number.NaN),
    category_id: str,
    screenshot_uri: str,
    cmd: str,
  })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    year: Number.isFinite(r.year) && r.year > 0 ? r.year : null,
    categoryId: r.category_id,
    poster: r.screenshot_uri,
    cmd: r.cmd,
  }));

export type StalkerSeries = z.output<typeof Series>;

export const parseSeries = (raw: unknown): StalkerSeries | null => parseWith(Series, raw);

/** Dernier nombre d'un identifiant composé (« 12:3 ») ou d'un libellé (« Saison 3 »). */
const trailingNumber = (...candidates: string[]): number => {
  for (const c of candidates) {
    const m = /(\d+)\D*$/.exec(c);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return 0;
};

const Season = z.object({ id: requiredStr, name: str, series: raw }).transform((r) => ({
  id: r.id,
  name: r.name,
  number: trailingNumber(r.id, r.name),
  episodeCount: looseList(r.series).length,
}));

export type StalkerSeason = z.output<typeof Season>;

export const parseSeason = (raw: unknown): StalkerSeason | null => parseWith(Season, raw);

const Episode = z
  .object({ id: requiredStr, name: str, series_number: num(Number.NaN), cmd: requiredStr })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    number: Number.isFinite(r.series_number) ? r.series_number : trailingNumber(r.id, r.name),
    cmd: r.cmd,
  }));

export type StalkerEpisode = z.output<typeof Episode>;

export const parseEpisode = (raw: unknown): StalkerEpisode | null => parseWith(Episode, raw);

const Radio = z
  .object({ id: requiredStr, name: str, number: num(0), genre_id: str, cmd: requiredStr })
  .transform((r) => ({ id: r.id, name: r.name, number: r.number, genreId: r.genre_id, cmd: r.cmd }));

export type StalkerRadio = z.output<typeof Radio>;

export const parseRadio = (raw: unknown): StalkerRadio | null => parseWith(Radio, raw);

const Link = z.object({ cmd: str, error: str });

/** Réponse de create_link : objet `{ cmd, error }` ou, sur d'anciens portails, la commande seule. */
export function parseLink(body: unknown): { cmd: string; error: string } {
  if (typeof body === 'string') return { cmd: body, error: '' };
  return Link.parse(isRecord(body) ? body : {});
}

/** Liste d'identifiants (favoris), nombres ou chaînes. */
export const parseIdList = (body: unknown): string[] =>
  looseList(body)
    .map(looseString)
    .filter((id) => id !== '');

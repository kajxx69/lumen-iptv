import type { FakePortalConfig } from '../config.js';
import { type Rng, hashSeed, intBetween, mulberry32, pick } from '../random.js';

export interface Genre {
  id: string;
  title: string;
  alias: string;
  censored: boolean;
}

export interface Channel {
  id: number;
  /** Identité indépendante du portail : même chaîne, même EPG sur deux portails. */
  canonicalIndex: number;
  name: string;
  number: number;
  genreId: string;
  /** Chemin relatif du logo, vide si la chaîne n'en a pas. */
  logoPath: string;
  xmltvId: string;
  archiveDays: number;
  censored: boolean;
  linkPrefix: '' | 'ffmpeg ' | 'auto ';
}

export interface Movie {
  id: number;
  name: string;
  originalName: string;
  description: string;
  year: number;
  director: string;
  actors: string;
  ratingImdb: number;
  durationMin: number;
  categoryId: string;
  censored: boolean;
}

export interface Series {
  id: number;
  name: string;
  description: string;
  year: number;
  categoryId: string;
  /** episodesPerSeason[i] = nombre d'épisodes de la saison i + 1. */
  episodesPerSeason: number[];
}

export interface RadioStation {
  id: number;
  name: string;
  number: number;
  genreId: string;
}

export interface Programme {
  /** Identifiant opaque encodant chaîne, début et durée, comme le font les portails. */
  id: string;
  channelId: number;
  name: string;
  description: string;
  category: string;
  startMs: number;
  endMs: number;
}

const TV_GENRES: readonly { title: string; alias: string; noun: string; censored?: boolean }[] = [
  { title: 'Généralistes', alias: 'general', noun: 'TV' },
  { title: 'Information', alias: 'news', noun: 'Info' },
  { title: 'Sport', alias: 'sport', noun: 'Sport' },
  { title: 'Cinéma', alias: 'cinema', noun: 'Ciné' },
  { title: 'Séries', alias: 'series', noun: 'Séries' },
  { title: 'Jeunesse', alias: 'kids', noun: 'Kids' },
  { title: 'Documentaires', alias: 'docs', noun: 'Découverte' },
  { title: 'Musique', alias: 'music', noun: 'Music' },
  { title: 'Divertissement', alias: 'entertainment', noun: 'Max' },
  { title: 'Afrique', alias: 'africa', noun: 'Afrique' },
  { title: 'Religion', alias: 'religion', noun: 'Foi' },
  { title: 'Régional', alias: 'regional', noun: 'Locale' },
  // Catégorie masquée par le contrôle parental ; contenu fictif et neutre.
  { title: 'Contrôle parental (test)', alias: 'parental', noun: 'Nuit', censored: true },
];

const WORDS = [
  'Lumen',
  'Horizon',
  'Savane',
  'Atlantique',
  'Baobab',
  'Lagune',
  'Sahel',
  'Comoé',
  'Delta',
  'Harmattan',
  'Kora',
  'Djembé',
  'Zénith',
  'Azur',
  'Étoile',
  'Soleil',
  'Océan',
  'Volta',
  'Bandama',
  'Fleuve',
  'Cauris',
  'Tamtam',
  'Ébène',
  'Acacia',
  'Kapok',
  'Iroko',
  'Néré',
  'Karité',
  'Mangrove',
  'Plateau',
] as const;

const COUNTRIES = [
  ['FR', 'France'],
  ['CI', 'Côte d’Ivoire'],
  ['SN', 'Sénégal'],
  ['ML', 'Mali'],
  ['BF', 'Burkina'],
  ['NG', 'Nigeria'],
  ['GH', 'Ghana'],
  ['CM', 'Cameroun'],
  ['BJ', 'Bénin'],
  ['TG', 'Togo'],
  ['UK', 'Royaume-Uni'],
  ['US', 'États-Unis'],
] as const;

const QUALITIES = ['SD', 'HD', 'FHD', '4K', ''] as const;

const VOD_CATEGORIES = [
  'Action',
  'Comédie',
  'Drame',
  'Documentaire',
  'Animation',
  'Nollywood',
  'Thriller',
  'Famille',
];
const SERIES_CATEGORIES = ['Feuilletons', 'Policier', 'Comédie', 'Animation', 'Téléréalité'];
const RADIO_GENRES = ['Musique', 'Information', 'Sport', 'Culture'];

const TITLE_NOUNS = [
  'Secret',
  'Retour',
  'Voyage',
  'Héritage',
  'Promesse',
  'Rivière',
  'Nuit',
  'Marché',
  'Village',
  'Chemin',
];
const TITLE_PLACES = [
  'Abidjan',
  'Dakar',
  'Bamako',
  'Lomé',
  'Cotonou',
  'Accra',
  'Lagos',
  'Ouaga',
  'Douala',
  'Paris',
];
const PEOPLE = [
  'A. Koné',
  'M. Diallo',
  'F. Traoré',
  'K. Mensah',
  'S. Ndiaye',
  'B. Ouédraogo',
  'Y. Adjoua',
  'C. Bamba',
];
const PROGRAMME_KINDS = [
  'Journal',
  'Magazine',
  'Film',
  'Série',
  'Documentaire',
  'Débat',
  'Concert',
  'Match',
  'Dessin animé',
];
const PROGRAMME_DURATIONS_MIN = [30, 45, 60, 60, 90, 120];
const ARCHIVE_DAYS = [1, 3, 7];

// Proportions observées sur des portails réels : de quoi exercer les cas dégradés.
const LOGO_PRESENT_RATIO = 0.85;
const LOGO_BROKEN_RATIO = 0.05;
const XMLTV_ID_RATIO = 0.85;
const ARCHIVE_RATIO = 0.3;
const CENSORED_CHANNEL_RATIO = 0.02;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

function title(rng: Rng): string {
  return `${pick(rng, ['Le', 'Un', 'Le dernier'])} ${pick(rng, TITLE_NOUNS)} de ${pick(rng, TITLE_PLACES)}`;
}

export class Catalog {
  readonly genres: Genre[];
  readonly channels: Channel[];
  readonly channelById = new Map<number, Channel>();
  readonly vodCategories: Genre[];
  readonly movies: Movie[];
  readonly movieById = new Map<number, Movie>();
  readonly seriesCategories: Genre[];
  readonly series: Series[];
  readonly seriesById = new Map<number, Series>();
  readonly radioGenres: Genre[];
  readonly radio: RadioStation[];

  constructor(private readonly config: FakePortalConfig) {
    this.genres = TV_GENRES.map((g, i) => ({
      id: String(i + 1),
      title: g.title,
      alias: g.alias,
      censored: g.censored === true,
    }));
    this.channels = this.generateChannels();
    for (const c of this.channels) this.channelById.set(c.id, c);
    this.vodCategories = VOD_CATEGORIES.map((t, i) => ({
      id: String(i + 1),
      title: t,
      alias: slug(t),
      censored: false,
    }));
    this.movies = this.generateMovies();
    for (const m of this.movies) this.movieById.set(m.id, m);
    this.seriesCategories = SERIES_CATEGORIES.map((t, i) => ({
      id: String(i + 1),
      title: t,
      alias: slug(t),
      censored: false,
    }));
    this.series = this.generateSeries();
    for (const s of this.series) this.seriesById.set(s.id, s);
    this.radioGenres = RADIO_GENRES.map((t, i) => ({
      id: String(i + 1),
      title: t,
      alias: slug(t),
      censored: false,
    }));
    this.radio = this.generateRadio();
  }

  /** Les identifiants dépendent de la graine : deux portails n'ont pas les mêmes. */
  private idBase(): number {
    return (this.config.seed - 1) * 100_000;
  }

  private generateChannels(): Channel[] {
    const seen = new Map<string, number>();
    const channels: Channel[] = [];
    for (let i = 0; i < this.config.channelCount; i++) {
      // Le contenu dépend de l'index canonique seul, pas de la graine du portail.
      const rng = mulberry32(hashSeed('channel', i));
      const censored = rng() < CENSORED_CHANNEL_RATIO;
      const genreIndex = censored ? TV_GENRES.length - 1 : Math.floor(rng() * (TV_GENRES.length - 1));
      const genre = TV_GENRES[genreIndex] ?? TV_GENRES[0];
      const [code, country] = pick(rng, COUNTRIES);
      const quality = pick(rng, QUALITIES);
      let base = `${pick(rng, WORDS)} ${genre?.noun ?? 'TV'}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      if (occurrence > 1) base = `${base} ${occurrence}`;

      const logoRoll = rng();
      const logoPath =
        logoRoll < LOGO_PRESENT_RATIO
          ? `/logos/${i}.png`
          : logoRoll < LOGO_PRESENT_RATIO + LOGO_BROKEN_RATIO
            ? `/logos/missing-${i}.png`
            : '';
      const xmltvId = rng() < XMLTV_ID_RATIO ? `${slug(base)}.${code.toLowerCase()}` : '';
      const archiveDays = rng() < ARCHIVE_RATIO ? pick(rng, ARCHIVE_DAYS) : 0;
      const prefixRoll = rng();

      channels.push({
        id: this.idBase() + i + 1,
        canonicalIndex: i,
        name: this.channelName(base, code, country, quality),
        number: i + 1,
        genreId: String(genreIndex + 1),
        logoPath,
        xmltvId,
        archiveDays,
        censored,
        linkPrefix: this.linkPrefix(prefixRoll),
      });
    }
    return channels;
  }

  private channelName(base: string, code: string, country: string, quality: string): string {
    if (this.config.namingStyle === 'pipe')
      return `${code} | ${base.toUpperCase()}${quality === '' ? '' : ` ${quality}`}`;
    const plainQuality: Record<string, string> = { FHD: ' 1080', '4K': ' UHD', HD: ' HD', SD: '', '': '' };
    return `${base} ${country}${plainQuality[quality] ?? ''}`;
  }

  private linkPrefix(roll: number): Channel['linkPrefix'] {
    switch (this.config.linkPrefixMode) {
      case 'none':
        return '';
      case 'ffmpeg':
        return 'ffmpeg ';
      case 'auto':
        return 'auto ';
      case 'mixed':
        return roll < 0.6 ? 'ffmpeg ' : roll < 0.8 ? 'auto ' : '';
    }
  }

  private generateMovies(): Movie[] {
    const out: Movie[] = [];
    for (let i = 0; i < this.config.vodCount; i++) {
      const rng = mulberry32(hashSeed('movie', i));
      const name = title(rng);
      out.push({
        id: this.idBase() + i + 1,
        name,
        originalName: name,
        description: `${pick(rng, PROGRAMME_KINDS)} fictif généré pour les tests.`,
        year: intBetween(rng, 1980, 2025),
        director: pick(rng, PEOPLE),
        actors: `${pick(rng, PEOPLE)}, ${pick(rng, PEOPLE)}`,
        ratingImdb: Math.round(intBetween(rng, 30, 90)) / 10,
        durationMin: intBetween(rng, 75, 150),
        categoryId: String(intBetween(rng, 1, VOD_CATEGORIES.length)),
        censored: false,
      });
    }
    return out;
  }

  private generateSeries(): Series[] {
    const out: Series[] = [];
    for (let i = 0; i < this.config.seriesCount; i++) {
      const rng = mulberry32(hashSeed('series', i));
      const seasons = intBetween(rng, 1, 5);
      out.push({
        id: this.idBase() + i + 1,
        name: title(rng),
        description: 'Série fictive générée pour les tests.',
        year: intBetween(rng, 1995, 2025),
        categoryId: String(intBetween(rng, 1, SERIES_CATEGORIES.length)),
        episodesPerSeason: Array.from({ length: seasons }, () => intBetween(rng, 6, 12)),
      });
    }
    return out;
  }

  private generateRadio(): RadioStation[] {
    const out: RadioStation[] = [];
    for (let i = 0; i < this.config.radioCount; i++) {
      const rng = mulberry32(hashSeed('radio', i));
      out.push({
        id: this.idBase() + i + 1,
        name: `Radio ${pick(rng, WORDS)} ${intBetween(rng, 88, 107)}.${intBetween(rng, 0, 9)}`,
        number: i + 1,
        genreId: String(intBetween(rng, 1, RADIO_GENRES.length)),
      });
    }
    return out;
  }

  /** Grille d'une journée UTC, générée à la demande : aucune mémoire pour 5 000 chaînes. */
  private programmesForDay(channel: Channel, day: number): Programme[] {
    const rng = mulberry32(hashSeed('epg', channel.canonicalIndex, day));
    const dayStart = day * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const out: Programme[] = [];
    let start = dayStart;
    let n = 0;
    while (start < dayEnd) {
      const durationMin = pick(rng, PROGRAMME_DURATIONS_MIN);
      const end = Math.min(dayEnd, start + durationMin * MINUTE_MS);
      const kind = pick(rng, PROGRAMME_KINDS);
      out.push({
        id: `${channel.id}_${start / 1000}_${(end - start) / MINUTE_MS}`,
        channelId: channel.id,
        name: `${kind} : ${title(rng)}`,
        description: `Programme fictif n°${++n} de la journée.`,
        category: kind,
        startMs: start,
        endMs: end,
      });
      start = end;
    }
    return out;
  }

  programmesBetween(channel: Channel, fromMs: number, toMs: number): Programme[] {
    const out: Programme[] = [];
    for (let day = Math.floor(fromMs / DAY_MS); day * DAY_MS < toMs; day++) {
      for (const p of this.programmesForDay(channel, day)) {
        if (p.endMs > fromMs && p.startMs < toMs) out.push(p);
      }
    }
    return out;
  }

  /** Les `size` programmes à partir de celui en cours. */
  nextProgrammes(channel: Channel, nowMs: number, size: number): Programme[] {
    const out: Programme[] = [];
    for (let day = Math.floor(nowMs / DAY_MS); out.length < size; day++) {
      for (const p of this.programmesForDay(channel, day)) {
        if (p.endMs > nowMs && out.length < size) out.push(p);
      }
    }
    return out;
  }
}

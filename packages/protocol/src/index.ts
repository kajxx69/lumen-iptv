import { z } from 'zod';

/**
 * Contrat HTTP entre le backend et les clients (web, puis Android et desktop).
 * Aucun de ces types ne transporte d'URL de portail, de MAC, de token ni d'identifiant.
 */

export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'too_many_streams',
  'portal_unreachable',
  'portal_device_rejected',
  'portal_auth_failed',
  'portal_error',
  'nothing_to_play',
  /** Aucune source de la chaîne n'a produit d'image dans le délai de démarrage. */
  'stream_unavailable',
  // Conversion vidéo saturée sur le serveur, ou format illisible par ce navigateur sans conversion.
  'transcode_busy',
  'unsupported_codec',
  /** Film ou épisode introuvable chez le portail, ou fichier illisible. */
  'vod_unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorDto = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ErrorDto = z.infer<typeof ErrorDto>;

// --- Authentification ---

export const LoginRequest = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Role = z.enum(['admin', 'user']);
export type Role = z.infer<typeof Role>;

export const MeDto = z.object({ username: z.string(), role: Role });
export type MeDto = z.infer<typeof MeDto>;

/** Longueur minimale d'un mot de passe : le relais est exposé, il ne doit pas devenir un proxy ouvert. */
export const PASSWORD_MIN_LENGTH = 10;

export const CreateUserRequest = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
  role: Role.default('user'),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

// --- Portails ---

export const DeviceModel = z.enum(['MAG250', 'MAG254', 'MAG322']);
export type DeviceModel = z.infer<typeof DeviceModel>;

export const CreatePortalRequest = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.url({ protocol: /^https?$/ }),
  mac: z
    .string()
    .trim()
    .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/),
  device: DeviceModel.default('MAG250'),
  login: z.string().max(256).optional(),
  password: z.string().max(256).optional(),
});
export type CreatePortalRequest = z.input<typeof CreatePortalRequest>;

export const PortalDto = z.object({
  id: z.string(),
  name: z.string(),
  /** Hôte seul : jamais le chemin ni la requête. */
  host: z.string(),
  /** MAC masquée, seuls les deux derniers octets restent lisibles. */
  macMasked: z.string(),
  device: DeviceModel,
  createdAt: z.number(),
});
export type PortalDto = z.infer<typeof PortalDto>;

/** Le portail répond-il ? Sinon, le client prévient et sert le catalogue de la dernière synchronisation. */
export const PortalHealthDto = z.object({
  portalId: z.string(),
  reachable: z.boolean(),
  checkedAt: z.number(),
  /** Dernière synchronisation réussie du catalogue, null si jamais. */
  syncedAt: z.number().nullable(),
});
export type PortalHealthDto = z.infer<typeof PortalHealthDto>;

// --- Catalogue ---

export const GenreDto = z.object({ id: z.string(), title: z.string(), censored: z.boolean() });
export type GenreDto = z.infer<typeof GenreDto>;

/**
 * Vue « Tous les portails » : un portail virtuel dont les chaînes sont les chaînes
 * fusionnées (même chaîne sur plusieurs portails = une entrée, plusieurs sources).
 */
export const ALL_PORTALS_ID = 'all';

/** Une source d'une chaîne fusionnée : la chaîne telle qu'elle existe sur un portail. */
export const ChannelSourceDto = z.object({
  portalId: z.string(),
  channelId: z.string(),
  name: z.string(),
});
export type ChannelSourceDto = z.infer<typeof ChannelSourceDto>;

export const ChannelDto = z.object({
  id: z.string(),
  name: z.string(),
  number: z.number(),
  genreId: z.string(),
  /** Chemin du logo servi par le backend, null si la chaîne n'en a pas. */
  logo: z.string().nullable(),
  epgId: z.string().nullable(),
  archiveHours: z.number(),
  censored: z.boolean(),
  /** Vue « Tous les portails » seulement : les sources de la chaîne fusionnée. */
  sources: z.array(ChannelSourceDto).optional(),
});
export type ChannelDto = z.infer<typeof ChannelDto>;

/** Correction manuelle : la chaîne est mise à part (MERGE_SOLO) ou rattachée au groupe visé. */
export const MERGE_SOLO_TARGET = 'solo';
const MERGE_TARGET_MAX_LENGTH = 300;

export const MergeOverrideDto = z.object({
  portalId: z.string().min(1),
  channelId: z.string().min(1),
  target: z.string().min(1).max(MERGE_TARGET_MAX_LENGTH),
});
export type MergeOverrideDto = z.infer<typeof MergeOverrideDto>;

export const MergeSettingsDto = z.object({
  /** Fusion active : la vue « Tous les portails » existe et les secours suivent les regroupements. */
  enabled: z.boolean(),
  overrides: z.array(MergeOverrideDto),
});
export type MergeSettingsDto = z.infer<typeof MergeSettingsDto>;

export const MergeSettingsRequest = z.object({ enabled: z.boolean() });
export type MergeSettingsRequest = z.infer<typeof MergeSettingsRequest>;

/** Pose (target) ou retire (null) la correction d'une chaîne. */
export const MergeOverrideRequest = z.object({
  portalId: z.string().min(1),
  channelId: z.string().min(1),
  target: z.string().min(1).max(MERGE_TARGET_MAX_LENGTH).nullable(),
});
export type MergeOverrideRequest = z.infer<typeof MergeOverrideRequest>;

export const ChannelListDto = z.object({
  portalId: z.string(),
  /** Change dès que la liste change : sert d'ETag et de clé de cache côté client. */
  version: z.string(),
  syncedAt: z.number(),
  channels: z.array(ChannelDto),
});
export type ChannelListDto = z.infer<typeof ChannelListDto>;

export const EpgEntryDto = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  start: z.number(),
  end: z.number(),
  catchup: z.boolean(),
});
export type EpgEntryDto = z.infer<typeof EpgEntryDto>;

/**
 * Chaînes au plus par requête d'EPG groupée : un écran de guide en affiche une vingtaine,
 * et chaque chaîne absente du cache coûte un appel au portail (limité à 5 par seconde).
 */
export const EPG_BATCH_MAX_CHANNELS = 40;

/** EPG de plusieurs chaînes : identifiant de chaîne → programmes de la fenêtre demandée. */
export const EpgBatchDto = z.record(z.string(), z.array(EpgEntryDto));
export type EpgBatchDto = z.infer<typeof EpgBatchDto>;

// --- Films et séries ---

/** Le même titre sur un autre portail (vue « Tous les portails ») : essayé si le premier échoue. */
export const VodSourceDto = z.object({ portalId: z.string(), id: z.string() });
export type VodSourceDto = z.infer<typeof VodSourceDto>;

export const MovieSummaryDto = z.object({
  id: z.string(),
  name: z.string(),
  year: z.number().nullable(),
  rating: z.number().nullable(),
  durationMin: z.number().nullable(),
  categoryId: z.string(),
  /** Affiche servie par Lumen (jamais l'adresse du portail) ; null : aucune. */
  poster: z.string().nullable(),
  censored: z.boolean(),
  /** Vue « Tous les portails » : chaque portail qui propose ce film, le préféré d'abord. */
  sources: z.array(VodSourceDto).optional(),
});
export type MovieSummaryDto = z.infer<typeof MovieSummaryDto>;

export const SeriesSummaryDto = z.object({
  id: z.string(),
  name: z.string(),
  year: z.number().nullable(),
  categoryId: z.string(),
  poster: z.string().nullable(),
  censored: z.boolean(),
  sources: z.array(VodSourceDto).optional(),
});
export type SeriesSummaryDto = z.infer<typeof SeriesSummaryDto>;

/**
 * Catalogue de films ou de séries d'un portail. Les grands portails se parcourent page par
 * page, lentement : tant que `complete` est faux, la liste grandit et le client la relit.
 */
const vodList = <T extends z.ZodType>(item: T) =>
  z.object({
    portalId: z.string(),
    version: z.string(),
    syncedAt: z.number(),
    complete: z.boolean(),
    categories: z.array(GenreDto),
    items: z.array(item),
  });
export const MovieListDto = vodList(MovieSummaryDto);
export type MovieListDto = z.infer<typeof MovieListDto>;
export const SeriesListDto = vodList(SeriesSummaryDto);
export type SeriesListDto = z.infer<typeof SeriesListDto>;

export const MovieDetailDto = MovieSummaryDto.extend({
  originalName: z.string(),
  description: z.string(),
  director: z.string(),
  actors: z.string(),
});
export type MovieDetailDto = z.infer<typeof MovieDetailDto>;

export const SeasonDto = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string(),
  episodeCount: z.number(),
});
export type SeasonDto = z.infer<typeof SeasonDto>;

export const SeriesDetailDto = SeriesSummaryDto.extend({
  description: z.string(),
  seasons: z.array(SeasonDto),
});
export type SeriesDetailDto = z.infer<typeof SeriesDetailDto>;

export const EpisodeDto = z.object({ id: z.string(), number: z.number(), name: z.string() });
export type EpisodeDto = z.infer<typeof EpisodeDto>;

const VodId = z.string().min(1).max(128);

/** Ce qu'on lit : un film, ou un épisode désigné par sa série et sa saison. */
export const VodItemRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('movie'), portalId: VodId, movieId: VodId }),
  z.object({
    kind: z.literal('episode'),
    portalId: VodId,
    seriesId: VodId,
    seasonId: VodId,
    episodeId: VodId,
  }),
  /**
   * Émission passée (ou en cours) d'une chaîne, lue dans l'archive du portail : rattrapage
   * depuis le guide, retour au début du programme, pause prolongée du direct. `start` et
   * `end` : horaires du programme (ms), tels que le guide les donne.
   */
  z.object({
    kind: z.literal('archive'),
    portalId: VodId,
    channelId: VodId,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
]);
export type VodItemRef = z.infer<typeof VodItemRef>;

// --- Lecture ---

/**
 * Sources de secours au plus par lecture : au-delà, une bascule de plus ne sauve plus
 * rien et chaque essai coûte une connexion amont.
 */
export const MAX_FALLBACK_SOURCES = 4;

export const ChannelRef = z.object({ portalId: z.string().min(1), channelId: z.string().min(1) });
export type ChannelRef = z.infer<typeof ChannelRef>;

/**
 * Ce que le navigateur sait décoder au-delà du socle H.264 + AAC (+ MP3). Inconnu : on
 * suppose le socle seul, et tout le reste est transcodé.
 */
export const ClientCapabilities = z.object({
  hevc: z.boolean().default(false),
  ac3: z.boolean().default(false),
  eac3: z.boolean().default(false),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilities>;

/**
 * Qualité demandée pour une lecture : la source telle quelle, ou un palier réduit (données
 * mobiles, réseau lent). « audio » : le son seul, l'image réduite à une vignette quasi fixe.
 */
export const QualityProfile = z.enum(['source', 'high', 'medium', 'low', 'audio']);
export type QualityProfile = z.infer<typeof QualityProfile>;

export const PlaybackRequest = ChannelRef.extend({
  /** La même chaîne sur d'autres portails, par ordre de préférence : le relais y bascule en cas de panne. */
  fallbacks: z.array(ChannelRef).max(MAX_FALLBACK_SOURCES).default([]),
  caps: ClientCapabilities.default({ hevc: false, ac3: false, eac3: false }),
  /**
   * « Direct au plus près » (LL-HLS) : la playlist annonce des parties de segment, le
   * lecteur joue à 3–5 s du direct. Sinon, confort : 20 s de retard qui absorbent les coupures.
   */
  lowLatency: z.boolean().default(false),
  quality: QualityProfile.default('source'),
});
export type PlaybackRequest = z.infer<typeof PlaybackRequest>;

/** Chaînes voisines à préparer (zapping instantané) : la précédente et la suivante, en général. */
export const PREFETCH_MAX_CHANNELS = 4;
export const PrefetchRequest = z.object({ channels: z.array(ChannelRef).max(PREFETCH_MAX_CHANNELS) });
export type PrefetchRequest = z.infer<typeof PrefetchRequest>;

export const StreamFormat = z.enum(['ts', 'hls']);

export const PlaybackDto = z.object({
  sessionId: z.string(),
  /**
   * Playlist HLS du relais, relative au backend. Elle ne change jamais pendant la lecture,
   * même quand le relais change de source ; l'URL amont reste côté serveur.
   */
  streamUrl: z.string(),
  format: StreamFormat,
});
export type PlaybackDto = z.infer<typeof PlaybackDto>;

export const RelayState = z.enum(['starting', 'live', 'recovering']);
export type RelayState = z.infer<typeof RelayState>;

/** État du relais vu par le lecteur : indicateur de source et de santé. */
export const PlaybackStatusDto = z.object({
  state: RelayState,
  /** Rang de la source en cours dans le classement par santé (0 = la meilleure au départ). */
  activeSource: z.number(),
  /** Portail qui fournit l'image en ce moment. */
  activePortalId: z.string(),
  sourceCount: z.number(),
  /** Secondes de flux gardées par le relais, disponibles pour le lecteur. */
  bufferedS: z.number(),
  /**
   * Conversion en cours pour ce navigateur (PROJECT.md §8), null si le flux est servi tel
   * quel. `hardware` faux : le processeur du serveur transcode, l'image est réduite.
   */
  transcode: z
    .object({ video: z.enum(['copy', 'h264']), audio: z.enum(['copy', 'aac']), hardware: z.boolean() })
    .nullable(),
  /**
   * Qualité demandée et qualité servie : elles diffèrent le temps d'un changement (la session
   * passe à la nouvelle sortie au prochain point de rendez-vous, sans coupure).
   */
  quality: z.object({ requested: QualityProfile, active: QualityProfile }),
});
export type PlaybackStatusDto = z.infer<typeof PlaybackStatusDto>;

export const PlaybackQualityRequest = z.object({ quality: QualityProfile });
export type PlaybackQualityRequest = z.infer<typeof PlaybackQualityRequest>;

/** Plafond d'un relevé : le lecteur en envoie toutes les 30 s ; au-delà, la valeur est suspecte. */
const STATS_MAX_MS = 10 * 60_000;

/** Ce que le spectateur a vécu depuis le dernier relevé : base du ratio de rebuffering. */
export const PlaybackStatsRequest = z.object({
  watchedMs: z.number().int().min(0).max(STATS_MAX_MS),
  stalledMs: z.number().int().min(0).max(STATS_MAX_MS),
});
export type PlaybackStatsRequest = z.infer<typeof PlaybackStatsRequest>;

/** Santé d'une source (une chaîne sur un portail), PROJECT.md §3. */
export const SourceHealthDto = ChannelRef.extend({
  resolveLatencyMs: z.number(),
  timeToFirstByteMs: z.number(),
  segmentFailureRate: z.number(),
  bitrateJitter: z.number(),
  freezeEventsPerHour: z.number(),
  contentEventsPerHour: z.number(),
  uptime24h: z.number(),
  samples: z.number(),
  score: z.number(),
});
export type SourceHealthDto = z.infer<typeof SourceHealthDto>;

/** Toutes les sources connues d'une chaîne, de la meilleure à la moins bonne. */
export const ChannelHealthDto = z.object({ sources: z.array(SourceHealthDto) });
export type ChannelHealthDto = z.infer<typeof ChannelHealthDto>;

// --- Bibliothèque personnelle (synchronisée entre appareils) ---

export const FavoriteDto = ChannelRef.extend({ addedAt: z.number() });
export type FavoriteDto = z.infer<typeof FavoriteDto>;

export const RecentDto = ChannelRef.extend({ watchedAt: z.number() });
export type RecentDto = z.infer<typeof RecentDto>;

/** Chaînes récentes gardées par utilisateur : de quoi remplir l'accueil, pas un historique. */
export const RECENTS_MAX = 20;

// --- Lecture de films et d'épisodes ---

/**
 * Origine des horodatages muraux (EXT-X-PROGRAM-DATE-TIME) d'une playlist de film : chaque
 * segment y porte sa position dans le film, comptée à partir de cette date. Le lecteur
 * retrouve ainsi la position exacte quelle que soit la reprise. Pas 1970 : une date nulle
 * se confond avec « absente » chez certains lecteurs.
 */
export const VOD_TIMELINE_EPOCH_MS = Date.UTC(2000, 0, 1);

export const VodPlayRequest = z.object({
  item: VodItemRef,
  /** Position de départ dans le film (s) : reprise, ou saut au-delà de ce qui est chargé. */
  startS: z.number().min(0).default(0),
  caps: ClientCapabilities.default({ hevc: false, ac3: false, eac3: false }),
  quality: QualityProfile.default('source'),
  /** Piste audio (indice parmi `audioTracks`) ; absente : celle que le fichier désigne par défaut. */
  audioTrack: z.number().int().min(0).max(64).optional(),
  /** Lecture remplacée (saut, changement de piste) : fermée d'abord, pour libérer la connexion au portail. */
  replaces: z.string().max(64).optional(),
  /**
   * Sous-titres en images à incruster (indice parmi `subtitleTracks`) : l'image est alors
   * convertie, s'il reste une place de conversion. Les sous-titres texte n'en ont pas besoin.
   */
  burnSubtitle: z.number().int().min(0).max(64).optional(),
});
export type VodPlayRequest = z.input<typeof VodPlayRequest>;
/** Requête validée, valeurs par défaut appliquées : ce que reçoit le serveur. */
export type VodPlayRequestParsed = z.output<typeof VodPlayRequest>;

export const VodAudioTrackDto = z.object({
  index: z.number(),
  language: z.string().nullable(),
  label: z.string(),
});
export type VodAudioTrackDto = z.infer<typeof VodAudioTrackDto>;

export const VodSubtitleTrackDto = z.object({
  index: z.number(),
  language: z.string().nullable(),
  label: z.string(),
  /** « text » : affiché par le lecteur, sans coût ; « image » : incrusté dans l'image (conversion). */
  kind: z.enum(['text', 'image']),
});
export type VodSubtitleTrackDto = z.infer<typeof VodSubtitleTrackDto>;

export const VodPlaybackDto = z.object({
  sessionId: z.string(),
  playlistUrl: z.string(),
  /** Durée du film (s) ; null si le fichier ne la donne pas. */
  durationS: z.number().nullable(),
  startS: z.number(),
  audioTracks: z.array(VodAudioTrackDto),
  audioTrack: z.number(),
  transcode: z.object({ video: z.boolean(), audio: z.boolean() }),
  quality: QualityProfile,
  subtitleTracks: z.array(VodSubtitleTrackDto),
  /** Sous-titres incrustés dans cette lecture ; null : aucun. */
  burnedSubtitle: z.number().nullable(),
  /** Message pour le spectateur (incrustation refusée faute de place, par exemple) ; null : rien à dire. */
  notice: z.string().nullable(),
});
export type VodPlaybackDto = z.infer<typeof VodPlaybackDto>;

/** Une réplique, en position dans le titre (s). */
export const SubtitleCueDto = z.object({ startS: z.number(), endS: z.number(), text: z.string() });
export type SubtitleCueDto = z.infer<typeof SubtitleCueDto>;

/**
 * Répliques extraites au fil de la lecture du fichier (elles arrivent avec les segments).
 * `next` : rang de la prochaine à demander (`?after=`) ; `complete` : fichier lu jusqu'au bout.
 */
export const SubtitleCuesDto = z.object({
  cues: z.array(SubtitleCueDto),
  next: z.number(),
  complete: z.boolean(),
});
export type SubtitleCuesDto = z.infer<typeof SubtitleCuesDto>;

// --- Reprise de lecture (synchronisée entre appareils) ---

export const ProgressKind = z.enum(['movie', 'episode']);
export type ProgressKind = z.infer<typeof ProgressKind>;

const ProgressFields = {
  kind: ProgressKind,
  portalId: z.string().min(1).max(128),
  /** Film, ou épisode. */
  itemId: z.string().min(1).max(128),
  seriesId: z.string().min(1).max(128).nullable(),
  seasonId: z.string().min(1).max(128).nullable(),
  positionS: z.number().min(0),
  durationS: z.number().min(0),
  /** Repère lisible d'un épisode (« S2 · É5 — Titre ») : l'accueil l'affiche sans rien demander au portail. */
  label: z.string().max(200).nullable(),
};

export const ProgressUpdateRequest = z.object(ProgressFields);
export type ProgressUpdateRequest = z.infer<typeof ProgressUpdateRequest>;

export const ProgressDto = z.object({ ...ProgressFields, finished: z.boolean(), updatedAt: z.number() });
export type ProgressDto = z.infer<typeof ProgressDto>;

/** Positions gardées par utilisateur : les plus récentes ; de quoi reprendre, pas un historique complet. */
export const PROGRESS_MAX = 200;
/**
 * Un titre est « vu » passé cette part de sa durée, ou, s'il est long, à moins de ce temps
 * de la fin (le générique) : il quitte « Reprendre », et une série passe à l'épisode suivant.
 */
export const FINISHED_RATIO = 0.95;
export const FINISHED_REMAINING_S = 180;
/** En deçà, la règle du générique ne s'applique pas : trois minutes seraient presque tout le titre. */
export const FINISHED_REMAINING_MIN_DURATION_S = 20 * 60;

export const isFinished = (positionS: number, durationS: number): boolean =>
  durationS > 0 &&
  (positionS >= durationS * FINISHED_RATIO ||
    (durationS >= FINISHED_REMAINING_MIN_DURATION_S && durationS - positionS <= FINISHED_REMAINING_S));

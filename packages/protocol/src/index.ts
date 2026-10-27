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

// --- Catalogue ---

export const GenreDto = z.object({ id: z.string(), title: z.string(), censored: z.boolean() });
export type GenreDto = z.infer<typeof GenreDto>;

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
});
export type ChannelDto = z.infer<typeof ChannelDto>;

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

export const VodDto = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  year: z.number().nullable(),
  durationMin: z.number().nullable(),
  rating: z.number().nullable(),
  categoryId: z.string(),
  censored: z.boolean(),
});
export type VodDto = z.infer<typeof VodDto>;

export const VodPageDto = z.object({
  page: z.number(),
  pageSize: z.number(),
  totalItems: z.number(),
  items: z.array(VodDto),
});
export type VodPageDto = z.infer<typeof VodPageDto>;

// --- Lecture ---

/**
 * Sources de secours au plus par lecture : au-delà, une bascule de plus ne sauve plus
 * rien et chaque essai coûte une connexion amont.
 */
export const MAX_FALLBACK_SOURCES = 4;

export const ChannelRef = z.object({ portalId: z.string().min(1), channelId: z.string().min(1) });
export type ChannelRef = z.infer<typeof ChannelRef>;

export const PlaybackRequest = ChannelRef.extend({
  /** La même chaîne sur d'autres portails, par ordre de préférence : le relais y bascule en cas de panne. */
  fallbacks: z.array(ChannelRef).max(MAX_FALLBACK_SOURCES).default([]),
});
export type PlaybackRequest = z.infer<typeof PlaybackRequest>;

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
  /** Rang de la source en cours : 0 = celle demandée, 1… = sources de secours. */
  activeSource: z.number(),
  sourceCount: z.number(),
  /** Secondes de flux gardées par le relais, disponibles pour le lecteur. */
  bufferedS: z.number(),
});
export type PlaybackStatusDto = z.infer<typeof PlaybackStatusDto>;

// --- Bibliothèque personnelle (synchronisée entre appareils) ---

export const FavoriteDto = ChannelRef.extend({ addedAt: z.number() });
export type FavoriteDto = z.infer<typeof FavoriteDto>;

export const RecentDto = ChannelRef.extend({ watchedAt: z.number() });
export type RecentDto = z.infer<typeof RecentDto>;

/** Chaînes récentes gardées par utilisateur : de quoi remplir l'accueil, pas un historique. */
export const RECENTS_MAX = 20;

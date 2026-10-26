import { z } from 'zod';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MASTER_KEY_BYTES = 32;

/**
 * Configuration unique du backend, lue depuis LUMEN_*. Chaque seuil est nommé et justifié.
 */
export const ServerConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(0).max(65535).default(8090),
  /** Fichier SQLite ; `:memory:` pour les tests. */
  databasePath: z.string().default('./data/lumen.db'),
  /**
   * Clé maître (32 octets en base64) qui chiffre URL, MAC et identifiants des portails.
   * Obligatoire : sans elle, le serveur refuse de démarrer plutôt que de stocker en clair.
   */
  masterKey: z
    .string({ error: 'LUMEN_MASTER_KEY est obligatoire (32 octets en base64)' })
    .refine((v) => Buffer.from(v, 'base64').length === MASTER_KEY_BYTES, {
      message: 'LUMEN_MASTER_KEY doit faire 32 octets encodés en base64 (openssl rand -base64 32)',
    }),
  /** Premier administrateur, créé au démarrage s'il n'existe aucun compte. */
  adminUsername: z.string().default('admin'),
  adminPassword: z.string().min(10).optional(),

  /** Cookie `Secure` : à désactiver seulement pour un accès HTTP en réseau local. */
  cookieSecure: z.boolean().default(true),
  /** Durée d'une session de connexion, prolongée à chaque usage. */
  sessionTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * DAY),
  /** Faire confiance à X-Forwarded-For derrière un reverse proxy (adresse client réelle). */
  trustProxy: z.boolean().default(false),

  /**
   * Requêtes d'API par utilisateur et par minute. Large pour un usage humain (zapping,
   * EPG), bas pour un robot qui utiliserait le relais comme proxy.
   */
  apiRequestsPerMinute: z.coerce.number().int().positive().default(600),
  /** Tentatives de connexion par couple (adresse, identifiant) et par fenêtre : anti force brute. */
  loginAttemptsPerWindow: z.coerce.number().int().positive().default(5),
  loginWindowMs: z.coerce.number().int().positive().default(MINUTE),
  /** Flux simultanés par utilisateur : 4 couvre la mosaïque 2×2 (la 3×3 relèvera ce plafond). */
  maxStreamsPerUser: z.coerce.number().int().positive().default(4),
  /** Plafond global : protège la bande passante sortante (≈ 3 Mbit/s par flux HD). */
  maxStreamsTotal: z.coerce.number().int().positive().default(20),
  /** Une session de lecture sans requête depuis ce délai est libérée. */
  playbackIdleTtlMs: z.coerce.number().int().positive().default(MINUTE),
  /** Délai d'obtention des en-têtes de la réponse amont d'un flux. */
  upstreamTimeoutMs: z.coerce.number().int().positive().default(10_000),

  /** Âge au-delà duquel le catalogue est rafraîchi en arrière-plan (servi entre-temps). */
  catalogTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * HOUR),
  epgCacheTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * MINUTE),
  /** Fenêtre EPG maximale par requête : au-delà, le portail ralentit et le client n'en a pas l'usage. */
  epgMaxWindowMs: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * DAY),
  /** Cache navigateur des logos : ils changent rarement et coûtent des données mobiles. */
  logoCacheMaxAgeS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(7 * 24 * 3600),

  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServerConfigInput = z.input<typeof ServerConfigSchema>;

const bool = (v: string): boolean => v === '1' || v.toLowerCase() === 'true';

export function configFromEnv(env: NodeJS.ProcessEnv): ServerConfig {
  const map: Record<string, string> = {
    host: 'HOST',
    port: 'PORT',
    databasePath: 'DATABASE_PATH',
    masterKey: 'MASTER_KEY',
    adminUsername: 'ADMIN_USERNAME',
    adminPassword: 'ADMIN_PASSWORD',
    sessionTtlMs: 'SESSION_TTL_MS',
    apiRequestsPerMinute: 'API_REQUESTS_PER_MINUTE',
    loginAttemptsPerWindow: 'LOGIN_ATTEMPTS_PER_WINDOW',
    loginWindowMs: 'LOGIN_WINDOW_MS',
    maxStreamsPerUser: 'MAX_STREAMS_PER_USER',
    maxStreamsTotal: 'MAX_STREAMS_TOTAL',
    playbackIdleTtlMs: 'PLAYBACK_IDLE_TTL_MS',
    upstreamTimeoutMs: 'UPSTREAM_TIMEOUT_MS',
    catalogTtlMs: 'CATALOG_TTL_MS',
    epgCacheTtlMs: 'EPG_CACHE_TTL_MS',
    epgMaxWindowMs: 'EPG_MAX_WINDOW_MS',
    logoCacheMaxAgeS: 'LOGO_CACHE_MAX_AGE_S',
    logLevel: 'LOG_LEVEL',
  };
  const input: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(map)) {
    const v = env[`LUMEN_${key}`];
    if (v !== undefined && v !== '') input[field] = v;
  }
  for (const [field, key] of [
    ['cookieSecure', 'COOKIE_SECURE'],
    ['trustProxy', 'TRUST_PROXY'],
  ] as const) {
    const v = env[`LUMEN_${key}`];
    if (v !== undefined && v !== '') input[field] = bool(v);
  }
  return ServerConfigSchema.parse(input);
}

export const resolveConfig = (input: ServerConfigInput): ServerConfig => ServerConfigSchema.parse(input);

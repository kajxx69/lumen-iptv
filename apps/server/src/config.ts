import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MASTER_KEY_BYTES = 32;
/** En dessous, le tampon ne couvre même pas une reconnexion. */
const MIN_RELAY_BUFFER_S = 6;
const MAX_RELAY_BUFFER_S = 120;
const MIN_METRICS_TOKEN_LENGTH = 16;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

/**
 * Configuration unique du backend, lue depuis LUMEN_*. Chaque seuil est nommé et justifié.
 */
export const ServerConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(0).max(65535).default(8090),
  /** Fichier SQLite ; `:memory:` pour les tests. */
  databasePath: z.string().default('./data/lumen.db'),
  /** Build de l'interface web (`pnpm --filter @lumen/web build`), servi sur la même origine. */
  webRoot: z.string().default(DEFAULT_WEB_ROOT),
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

  /**
   * Profondeur du tampon glissant de chaque relais. C'est la durée de coupure amont qu'un
   * spectateur placé en retard sur le direct traverse sans rien voir (PROJECT.md : 30 s,
   * 120 s au plus ; ≈ 11 Mo par chaîne SD à 30 s).
   */
  relayBufferS: z.coerce.number().min(MIN_RELAY_BUFFER_S).max(MAX_RELAY_BUFFER_S).default(30),
  /** Durée visée des segments : 2 s équilibre zapping rapide et nombre de requêtes. */
  relaySegmentTargetS: z.coerce.number().min(1).max(4).default(2),
  /** Premiers segments d'une nouvelle source plus courts : la lecture démarre (ou reprend) plus tôt. */
  relayFirstSegmentTargetS: z.coerce.number().min(0.5).max(4).default(0.5),
  /**
   * Démarrage rapide d'une nouvelle source (zapping, bascule) : pendant ces secondes, coupe
   * sans attendre l'image clé. Le lecteur n'attend pas un GOP entier pour recevoir la suite.
   */
  relayFastStartS: z.coerce.number().min(0).max(10).default(2),
  /**
   * EXT-X-TARGETDURATION, figée pour la vie d'un relais (RFC 8216). Large pour absorber les
   * GOP longs de certaines chaînes ; au-delà, le relais coupe sans attendre d'image clé.
   */
  relayTargetDurationS: z.coerce.number().int().min(3).max(10).default(6),
  /**
   * Sans nouveau segment depuis ce délai, la connexion amont est jugée bloquée et rouverte.
   * Supérieur à la coupure forcée (durée cible − 0,5 s) pour ne jamais condamner un GOP long.
   */
  relayStallTimeoutMs: z.coerce.number().int().positive().default(8000),
  /** Attente maximale du premier segment au démarrage d'une lecture. */
  relayStartTimeoutMs: z.coerce.number().int().positive().default(15_000),
  /** Délai de grâce d'un relais sans spectateur (retour rapide sur la chaîne sans reconnexion). */
  relayLingerMs: z.coerce.number().int().nonnegative().default(15_000),
  /** Cache des segments sortis des tampons (lecteurs en retard), tous relais confondus. */
  relaySegmentCacheBytes: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(128 * 1024 * 1024),
  /** Politique de reprise (PROJECT.md) : 200 ms, 400 ms, 800 ms… plafonné à 10 s. */
  relayRetryInitialDelayMs: z.coerce.number().int().positive().default(200),
  relayRetryMaxDelayMs: z.coerce.number().int().positive().default(10_000),
  /**
   * Plafond des tentatives tant que des spectateurs ont encore du tampon : au-delà de 2 s
   * d'attente, la reprise risquerait d'arriver après la fin de leur tampon.
   */
  relayRetryBufferedMaxDelayMs: z.coerce.number().int().positive().default(2000),
  /** Un segment HLS amont manquant est réessayé jusqu'à ce délai, puis sauté. */
  hlsSegmentRetryDeadlineMs: z.coerce.number().int().positive().default(4000),

  /**
   * Gel : octets reçus mais horodatages figés depuis ce délai. PROJECT.md exige une détection
   * en moins de 2,5 s : 2 s plus la période de vérification (250 ms) tiennent cette cible. C'est
   * la panne que les lecteurs classiques ne voient jamais : la connexion vit, l'image est figée.
   */
  freezeDetectionMs: z.coerce.number().int().positive().default(2000),
  /** Image noire ou silence prolongé au-delà de cette durée (PROJECT.md : 10 s). */
  contentFailureS: z.coerce.number().positive().default(10),
  /** Analyse d'image et de son par FFmpeg (un processus par segment, quelques % de CPU). */
  contentDetection: z.boolean().default(true),
  /** Analyses FFmpeg simultanées pour tout le serveur : le reste attend son tour ou est sauté. */
  contentAnalysisMaxConcurrent: z.coerce.number().int().positive().default(2),
  ffmpegPath: z.string().default('ffmpeg'),

  /** Sondes de fond : connaître l'état d'une chaîne avant que l'utilisateur ne clique dessus. */
  probes: z.boolean().default(true),
  /** Chaque favori est sondé à ce rythme (PROJECT.md : 15 min). */
  probeFavoritesIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * MINUTE),
  /** Balayage du catalogue complet la nuit, heures locales [début, fin) : réseau et portail au calme. */
  probeCatalogStartHour: z.coerce.number().int().min(0).max(23).default(3),
  probeCatalogEndHour: z.coerce.number().int().min(1).max(24).default(6),
  /** 600 sondes par heure (une toutes les 6 s) : invisible pour le portail, 5 000 chaînes en 3 nuits. */
  probeCatalogPerHour: z.coerce.number().int().positive().default(600),

  /**
   * Jeton exigé par /metrics (en-tête `Authorization: Bearer …`). Sans jeton, /metrics est
   * désactivé : les métriques ne sortent jamais sans qu'on l'ait décidé.
   */
  metricsToken: z.string().min(MIN_METRICS_TOKEN_LENGTH).optional(),

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
    webRoot: 'WEB_ROOT',
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
    relayBufferS: 'RELAY_BUFFER_S',
    relaySegmentTargetS: 'RELAY_SEGMENT_TARGET_S',
    relayFirstSegmentTargetS: 'RELAY_FIRST_SEGMENT_TARGET_S',
    relayFastStartS: 'RELAY_FAST_START_S',
    relayTargetDurationS: 'RELAY_TARGET_DURATION_S',
    relayStallTimeoutMs: 'RELAY_STALL_TIMEOUT_MS',
    relayStartTimeoutMs: 'RELAY_START_TIMEOUT_MS',
    relayLingerMs: 'RELAY_LINGER_MS',
    relaySegmentCacheBytes: 'RELAY_SEGMENT_CACHE_BYTES',
    relayRetryInitialDelayMs: 'RELAY_RETRY_INITIAL_DELAY_MS',
    relayRetryMaxDelayMs: 'RELAY_RETRY_MAX_DELAY_MS',
    relayRetryBufferedMaxDelayMs: 'RELAY_RETRY_BUFFERED_MAX_DELAY_MS',
    hlsSegmentRetryDeadlineMs: 'HLS_SEGMENT_RETRY_DEADLINE_MS',
    freezeDetectionMs: 'FREEZE_DETECTION_MS',
    contentFailureS: 'CONTENT_FAILURE_S',
    contentAnalysisMaxConcurrent: 'CONTENT_ANALYSIS_MAX_CONCURRENT',
    ffmpegPath: 'FFMPEG_PATH',
    probeFavoritesIntervalMs: 'PROBE_FAVORITES_INTERVAL_MS',
    probeCatalogStartHour: 'PROBE_CATALOG_START_HOUR',
    probeCatalogEndHour: 'PROBE_CATALOG_END_HOUR',
    probeCatalogPerHour: 'PROBE_CATALOG_PER_HOUR',
    metricsToken: 'METRICS_TOKEN',
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
    ['contentDetection', 'CONTENT_DETECTION'],
    ['probes', 'PROBES'],
  ] as const) {
    const v = env[`LUMEN_${key}`];
    if (v !== undefined && v !== '') input[field] = bool(v);
  }
  // Même variable que le portail factice et les tests : FFmpeg n'est configuré qu'une fois.
  const ffmpeg = env['FFMPEG_PATH'];
  if (input['ffmpegPath'] === undefined && ffmpeg !== undefined && ffmpeg !== '')
    input['ffmpegPath'] = ffmpeg;
  return ServerConfigSchema.parse(input);
}

export const resolveConfig = (input: ServerConfigInput): ServerConfig => ServerConfigSchema.parse(input);

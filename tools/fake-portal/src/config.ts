import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Configuration unique du portail factice. Chaque valeur est surchargeable par
 * variable d'environnement (FAKE_PORTAL_*) ou par `createFakePortal({ ... })` en test.
 */

const DEFAULT_ASSET_DIR = fileURLToPath(new URL('../.cache/assets', import.meta.url));

export const FakePortalConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(0).max(65535).default(8080),

  /** Graine du générateur : deux instances de même graine exposent le même catalogue. */
  seed: z.coerce.number().int().default(1),
  portalName: z.string().default('Lumen Fake Portal'),
  /**
   * Style de nommage des chaînes. Deux portails de styles différents exposent les mêmes
   * chaînes sous des noms différents, pour tester le dédoublonnage (phase 6).
   */
  namingStyle: z.enum(['pipe', 'plain']).default('pipe'),

  /** Volume réaliste d'un portail moyen ; PROJECT.md fixe 5 000 chaînes. */
  channelCount: z.coerce.number().int().min(1).default(5000),
  vodCount: z.coerce.number().int().min(0).default(1500),
  seriesCount: z.coerce.number().int().min(0).default(300),
  radioCount: z.coerce.number().int().min(0).default(200),
  /** Taille de page observée sur la plupart des portails Stalker. */
  pageSize: z.coerce.number().int().min(1).default(14),

  /**
   * Chemins sur lesquels l'API répond. Restreindre la liste permet de tester la
   * découverte automatique du point d'entrée côté client.
   */
  entrypoints: z
    .array(z.string().startsWith('/'))
    .min(1)
    .default(['/stalker_portal/server/load.php', '/server/load.php', '/portal.php', '/c/portal.php']),

  /** Si vrai, get_profile renvoie status=2 tant que do_auth n'a pas réussi. */
  requireDoAuth: z.boolean().default(false),
  /** Identifiants fictifs, utilisés seulement quand requireDoAuth est actif. */
  login: z.string().default('demo'),
  password: z.string().default('demo'),
  /** Modèles acceptés dans X-User-Agent ; certains portails filtrent sur le modèle. */
  allowedModels: z
    .array(z.string())
    .default(['MAG200', 'MAG250', 'MAG254', 'MAG256', 'MAG322', 'MAG324', 'MAG420']),

  /** Durée de vie d'un token de session sans renouvellement. */
  sessionTokenTtlMs: z.coerce.number().int().positive().default(3_600_000),
  /**
   * Fenêtre pendant laquelle une URL de create_link peut ouvrir un flux. Courte, comme sur
   * les vrais portails : elle force le client à régénérer le lien à chaque (re)connexion.
   */
  playTokenTtlMs: z.coerce.number().int().positive().default(30_000),

  /** Au-delà, la MAC est bannie : c'est le comportement des portails saturés. */
  apiRateLimitPerSecond: z.coerce.number().positive().default(20),
  macBanDurationMs: z.coerce.number().int().nonnegative().default(60_000),
  banStatusCode: z.coerce.number().int().min(400).max(599).default(429),

  /** Format de l'URL renvoyée par create_link pour les chaînes en direct. */
  streamFormat: z.enum(['ts', 'm3u8']).default('ts'),
  /** Préfixe parasite ajouté à l'URL de create_link ; `mixed` varie selon la chaîne. */
  linkPrefixMode: z.enum(['mixed', 'none', 'ffmpeg', 'auto']).default('mixed'),
  /** Les vrais portails renvoient la plupart des nombres sous forme de chaînes. */
  stringNumbers: z.boolean().default(true),
  /** Réponses sans enveloppe `{ js: … }`, variante de certains middlewares anciens. */
  omitJsEnvelope: z.boolean().default(false),
  /**
   * Actions désactivées, sous la forme `type.action` (ex. `itv.get_all_channels`) : elles
   * répondent une liste vide, comme les portails qui coupent les requêtes coûteuses.
   */
  disabledActions: z.array(z.string()).default([]),

  /**
   * Origine de l'horloge des flux. Placée dans le passé pour que les numéros de segment
   * et les archives (timeshift) soient positifs dès le démarrage.
   */
  liveEpochPrerollMs: z.coerce.number().int().nonnegative().default(3_600_000),

  media: z
    .object({
      /** Durée d'un segment ; aussi la période des images clés (GOP). */
      segmentDurationS: z.coerce.number().int().positive().default(2),
      /**
       * Longueur de la boucle de mire. 64 s est un multiple exact de la durée d'une trame
       * AAC (1024 échantillons à 48 kHz), ce qui évite une dérive audio au rebouclage.
       */
      loopDurationS: z.coerce.number().int().positive().default(64),
      videoSize: z
        .string()
        .regex(/^\d+x\d+$/)
        .default('640x360'),
      fps: z.coerce.number().int().positive().default(25),
      /** Débit proche d'une chaîne SD réelle, assez haut pour que l'étranglement soit mesurable. */
      videoBitrateKbps: z.coerce.number().int().positive().default(1200),
      audioBitrateKbps: z.coerce.number().int().positive().default(96),
      audioSampleRate: z.coerce.number().int().positive().default(48_000),
      /**
       * Codecs diffusés : H.264 + AAC par défaut ; HEVC, MPEG-2 et AC-3 pour éprouver le
       * transcodage (PROJECT.md §8). Une trame AC-3 (1 536 échantillons) tombe juste sur la boucle.
       */
      videoCodec: z.enum(['h264', 'hevc', 'mpeg2']).default('h264'),
      audioCodec: z.enum(['aac', 'ac3']).default('aac'),
    })
    .prefault({}),

  /** Nombre de segments listés dans la playlist HLS en direct. */
  hlsWindowSegments: z.coerce.number().int().positive().default(6),
  /** Segments encore téléchargeables derrière la fenêtre (clients en retard). */
  hlsRetainSegments: z.coerce.number().int().positive().default(30),
  /** Segments envoyés d'un coup à l'ouverture d'un flux TS, comme un serveur qui part de la dernière image clé. */
  tsInitialBurstSegments: z.coerce.number().int().nonnegative().default(1),
  /** Découpage d'un segment en envois successifs : 10 → un envoi toutes les 200 ms. */
  tsPacingChunksPerSegment: z.coerce.number().int().positive().default(10),
  /** Part des paquets TS altérés dans un segment désigné comme corrompu. */
  corruptPacketRatio: z.coerce.number().min(0).max(1).default(0.05),
  /** Plafond de durée d'une archive demandée via tv_archive. */
  archiveMaxDurationMin: z.coerce.number().int().positive().default(240),

  assetDir: z.string().default(DEFAULT_ASSET_DIR),
  ffmpegPath: z.string().default('ffmpeg'),
  /** L'API /_chaos n'a de sens qu'en test ; elle peut être coupée. */
  chaosEnabled: z.boolean().default(true),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type FakePortalConfig = z.infer<typeof FakePortalConfigSchema>;
export type FakePortalConfigInput = z.input<typeof FakePortalConfigSchema>;
export type MediaConfig = FakePortalConfig['media'];

const ENV_PREFIX = 'FAKE_PORTAL_';

const parseBool = (v: string): boolean => v === '1' || v.toLowerCase() === 'true';
const parseList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Lit FAKE_PORTAL_* ; les clés sont la version SNAKE_CASE des champs du schéma. */
export function configFromEnv(env: NodeJS.ProcessEnv): FakePortalConfig {
  const read = (key: string): string | undefined => env[ENV_PREFIX + key];
  const input: Record<string, unknown> = {};
  const scalar: [string, string][] = [
    ['host', 'HOST'],
    ['port', 'PORT'],
    ['seed', 'SEED'],
    ['portalName', 'NAME'],
    ['namingStyle', 'NAMING_STYLE'],
    ['channelCount', 'CHANNEL_COUNT'],
    ['vodCount', 'VOD_COUNT'],
    ['seriesCount', 'SERIES_COUNT'],
    ['radioCount', 'RADIO_COUNT'],
    ['pageSize', 'PAGE_SIZE'],
    ['login', 'LOGIN'],
    ['password', 'PASSWORD'],
    ['sessionTokenTtlMs', 'SESSION_TOKEN_TTL_MS'],
    ['playTokenTtlMs', 'PLAY_TOKEN_TTL_MS'],
    ['apiRateLimitPerSecond', 'API_RATE_LIMIT_PER_SECOND'],
    ['macBanDurationMs', 'MAC_BAN_DURATION_MS'],
    ['banStatusCode', 'BAN_STATUS_CODE'],
    ['streamFormat', 'STREAM_FORMAT'],
    ['linkPrefixMode', 'LINK_PREFIX_MODE'],
    ['liveEpochPrerollMs', 'LIVE_EPOCH_PREROLL_MS'],
    ['hlsWindowSegments', 'HLS_WINDOW_SEGMENTS'],
    ['hlsRetainSegments', 'HLS_RETAIN_SEGMENTS'],
    ['tsInitialBurstSegments', 'TS_INITIAL_BURST_SEGMENTS'],
    ['tsPacingChunksPerSegment', 'TS_PACING_CHUNKS_PER_SEGMENT'],
    ['corruptPacketRatio', 'CORRUPT_PACKET_RATIO'],
    ['archiveMaxDurationMin', 'ARCHIVE_MAX_DURATION_MIN'],
    ['assetDir', 'ASSET_DIR'],
    ['logLevel', 'LOG_LEVEL'],
  ];
  for (const [field, key] of scalar) {
    const v = read(key);
    if (v !== undefined && v !== '') input[field] = v;
  }
  const bools: [string, string][] = [
    ['requireDoAuth', 'REQUIRE_DO_AUTH'],
    ['stringNumbers', 'STRING_NUMBERS'],
    ['omitJsEnvelope', 'OMIT_JS_ENVELOPE'],
    ['chaosEnabled', 'CHAOS_ENABLED'],
  ];
  for (const [field, key] of bools) {
    const v = read(key);
    if (v !== undefined && v !== '') input[field] = parseBool(v);
  }
  const lists: [string, string][] = [
    ['entrypoints', 'ENTRYPOINTS'],
    ['allowedModels', 'ALLOWED_MODELS'],
    ['disabledActions', 'DISABLED_ACTIONS'],
  ];
  for (const [field, key] of lists) {
    const v = read(key);
    if (v !== undefined && v !== '') input[field] = parseList(v);
  }
  const media: Record<string, string> = {};
  for (const [field, key] of [
    ['videoCodec', 'VIDEO_CODEC'],
    ['audioCodec', 'AUDIO_CODEC'],
  ] as const) {
    const v = read(key);
    if (v !== undefined && v !== '') media[field] = v;
  }
  if (Object.keys(media).length > 0) input['media'] = media;
  const ffmpeg = env['FFMPEG_PATH'];
  if (ffmpeg !== undefined && ffmpeg !== '') input['ffmpegPath'] = ffmpeg;
  return FakePortalConfigSchema.parse(input);
}

export function resolveConfig(overrides: FakePortalConfigInput = {}): FakePortalConfig {
  return FakePortalConfigSchema.parse(overrides);
}

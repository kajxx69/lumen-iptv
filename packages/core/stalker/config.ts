/**
 * Réglages du client Stalker. Chaque valeur est surchargeable via `tuning` ; les
 * défauts sont ceux de PROJECT.md ou, à défaut, justifiés ici.
 */
export interface StalkerTuning {
  /** Délai maximal d'une requête au portail. Au-delà, le réseau mobile est jugé perdu pour cette tentative. */
  requestTimeoutMs: number;
  /** PROJECT.md : 5 req/s. Un portail saturé bannit la MAC. */
  rateLimitPerSecond: number;
  /** PROJECT.md : 4 requêtes parallèles maximum pendant la pagination. */
  pageConcurrency: number;
  /** Relances après la première tentative, pour les erreurs passagères (réseau, délai, 5xx, 401/403). */
  retryAttempts: number;
  /** Premier délai de recul ; doublé à chaque relance (200, 400, 800 ms…). */
  retryBaseDelayMs: number;
  /** Plafond du recul exponentiel (PROJECT.md : 10 s). */
  retryMaxDelayMs: number;
  /** Gigue ± sur chaque délai, pour éviter que plusieurs clients relancent en même temps. */
  retryJitterRatio: number;
  /**
   * Tours supplémentaires sur une page dont toutes les relances ont échoué : perdre une page
   * au milieu de 100 000 entrées coûte plus cher qu'une seconde d'attente.
   */
  pageRetryRounds: number;
  pageRetryDelayMs: number;
  /** Garde-fou contre un portail qui renverrait des pages sans fin. */
  maxPages: number;
  /** PROJECT.md : get_profile périodique, 10 minutes par défaut. */
  keepAliveIntervalMs: number;
}

export const DEFAULT_TUNING: StalkerTuning = {
  requestTimeoutMs: 10_000,
  rateLimitPerSecond: 5,
  pageConcurrency: 4,
  retryAttempts: 3,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 10_000,
  retryJitterRatio: 0.2,
  pageRetryRounds: 2,
  pageRetryDelayMs: 1_000,
  maxPages: 10_000,
  keepAliveIntervalMs: 600_000,
};

export interface DeviceProfile {
  model: string;
  userAgent: string;
  /** Valeur `ver` envoyée à get_profile. */
  firmware: string;
}

/**
 * Profils d'appareil connus. Certains portails filtrent sur le modèle déclaré ; les
 * chaînes exactes varient selon les firmwares, d'où la possibilité d'un profil personnalisé.
 */
export const DEVICE_PROFILES = {
  MAG250: {
    model: 'MAG250',
    userAgent:
      'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    firmware:
      'ImageDescription: 0.2.18-r23-250; ImageDate: Thu Sep 13 11:31:16 EEST 2018; PORTAL version: 5.6.1',
  },
  MAG254: {
    model: 'MAG254',
    userAgent:
      'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 1812 Mobile Safari/533.3',
    firmware:
      'ImageDescription: 0.2.18-r23-254; ImageDate: Wed Oct 31 15:22:54 EEST 2018; PORTAL version: 5.6.1',
  },
  MAG322: {
    model: 'MAG322',
    userAgent:
      'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2116 Mobile Safari/533.3',
    firmware:
      'ImageDescription: 0.2.18-r23-322; ImageDate: Tue Nov 26 16:16:38 EET 2019; PORTAL version: 5.6.1',
  },
} as const satisfies Record<string, DeviceProfile>;

export type DeviceProfileName = keyof typeof DEVICE_PROFILES;

/** Langue et fuseau annoncés dans le cookie ; Abidjan = UTC, cible principale du projet. */
export const DEFAULT_LANGUAGE = 'fr';
export const DEFAULT_TIMEZONE = 'Africa/Abidjan';

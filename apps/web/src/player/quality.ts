import type { QualityProfile } from '@lumen/protocol';
import type { NetworkInfo, NetworkKind } from './network.js';

/** Paliers, du meilleur au plus léger. */
export const QUALITY_ORDER: readonly QualityProfile[] = ['source', 'high', 'medium', 'low', 'audio'];

/**
 * Débit total d'un palier (vidéo + son, kbit/s), le même que celui du serveur
 * (transcode/plan). « source » : estimation prudente, remplacée par la mesure réelle.
 */
export const PROFILE_KBPS: Record<QualityProfile, number> = {
  source: 3000,
  high: 2600,
  medium: 1100,
  low: 560,
  audio: 95,
};

export const QUALITY_LABEL: Record<QualityProfile, string> = {
  source: 'Source',
  high: '720p',
  medium: '480p',
  low: '360p',
  audio: 'Audio seul',
};

const rank = (q: QualityProfile): number => QUALITY_ORDER.indexOf(q);
const lighter = (a: QualityProfile, b: QualityProfile): QualityProfile => (rank(a) >= rank(b) ? a : b);

export const stepDown = (q: QualityProfile): QualityProfile => QUALITY_ORDER[rank(q) + 1] ?? q;
export const stepUp = (q: QualityProfile): QualityProfile => QUALITY_ORDER[Math.max(0, rank(q) - 1)] ?? q;

export interface QualityPrefs extends Record<NetworkKind, QualityProfile> {
  /** Économie de données : basse qualité au plus, sur tous les réseaux. */
  dataSaver: boolean;
}

export const DEFAULT_QUALITY_PREFS: QualityPrefs = {
  wifi: 'source',
  // Données mobiles : 480p, net sur un téléphone, ≈ 500 Mo par heure.
  cellular: 'medium',
  unknown: 'source',
  dataSaver: false,
};

/** Qualité maximale permise sur ce réseau. */
export function capFor(network: NetworkInfo, prefs: QualityPrefs): QualityProfile {
  const cap = prefs[network.kind];
  return prefs.dataSaver || network.saveData ? lighter(cap, 'low') : cap;
}

export interface QualityOptions {
  /** Débit mesuré sous (palier × marge) pendant ce délai : on descend. */
  downMargin: number;
  downAfterMs: number;
  /** Débit au-dessus de (palier supérieur × marge) pendant ce délai, sans arrêt récent : on monte. */
  upMargin: number;
  upAfterMs: number;
  /** Pas de montée tant qu'un arrêt d'image date de moins que cela. */
  upCalmMs: number;
  /** Calme imposé après un changement : pas de va-et-vient. */
  cooldownMs: number;
  /** Le contrôleur ne descend pas seul sous ce palier (l'audio seul est un choix). */
  floor: QualityProfile;
}

export const QUALITY_CONTROL: QualityOptions = {
  downMargin: 1.2,
  downAfterMs: 10_000,
  upMargin: 2,
  upAfterMs: 60_000,
  upCalmMs: 120_000,
  cooldownMs: 30_000,
  floor: 'low',
};

export interface QualitySample {
  now: number;
  /** Débit estimé du réseau (bit/s), null s'il est encore inconnu. */
  bandwidthBps: number | null;
  /** Une coupure de lecture depuis le dernier relevé. */
  stalled: boolean;
}

/**
 * Qualité automatique : descend vite (un arrêt d'image, ou un débit trop juste quelques
 * secondes), remonte lentement (débit largement suffisant depuis une minute, aucun arrêt
 * depuis deux), jamais au-dessus du plafond du réseau.
 */
export class QualityController {
  private tightSince: number | null = null;
  private ampleSince: number | null = null;
  private lastStall = -Infinity;
  private lastChange = -Infinity;

  constructor(private readonly options: QualityOptions = QUALITY_CONTROL) {}

  decide(sample: QualitySample, current: QualityProfile, cap: QualityProfile): QualityProfile {
    const o = this.options;
    const { now, bandwidthBps } = sample;
    if (sample.stalled) this.lastStall = now;
    // Au-dessus du plafond (réseau changé, réglage modifié) : on y revient aussitôt.
    if (rank(current) < rank(cap)) return this.change(cap, now);
    if (now - this.lastChange < o.cooldownMs) return current;

    const kbps = bandwidthBps === null ? null : bandwidthBps / 1000;
    const tight = kbps !== null && kbps < PROFILE_KBPS[current] * o.downMargin;
    this.tightSince = tight ? (this.tightSince ?? now) : null;
    const canGoDown = rank(current) < rank(o.floor);
    if (
      canGoDown &&
      (sample.stalled || (this.tightSince !== null && now - this.tightSince >= o.downAfterMs))
    ) {
      return this.change(this.fitting(current, kbps), now);
    }

    const up = stepUp(current);
    const ample =
      up !== current && rank(up) >= rank(cap) && kbps !== null && kbps > PROFILE_KBPS[up] * o.upMargin;
    this.ampleSince = ample ? (this.ampleSince ?? now) : null;
    if (
      this.ampleSince !== null &&
      now - this.ampleSince >= o.upAfterMs &&
      now - this.lastStall >= o.upCalmMs
    ) {
      return this.change(up, now);
    }
    return current;
  }

  /**
   * Palier où descendre : débit connu, le meilleur qui y tient (droit au but, sans passer par
   * chaque palier) ; inconnu, le palier juste en dessous. Jamais sous le plancher.
   */
  private fitting(current: QualityProfile, kbps: number | null): QualityProfile {
    const floor = rank(this.options.floor);
    if (kbps === null) return QUALITY_ORDER[Math.min(rank(current) + 1, floor)] ?? current;
    const fits = QUALITY_ORDER.slice(rank(current) + 1, floor + 1).find(
      (q) => PROFILE_KBPS[q] * this.options.downMargin <= kbps,
    );
    return fits ?? this.options.floor;
  }

  private change(to: QualityProfile, now: number): QualityProfile {
    this.lastChange = now;
    this.tightSince = null;
    this.ampleSince = null;
    return to;
  }
}

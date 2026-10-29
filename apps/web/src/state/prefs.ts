import { create } from 'zustand';
import { DEFAULT_QUALITY_PREFS, QUALITY_ORDER, type QualityPrefs } from '../player/quality.js';

/**
 * Préférences propres à cet appareil (pas au compte) : le portail affiché, les chaînes
 * regardées « au plus près du direct ». Le stockage local peut être indisponible
 * (navigation privée) : l'application marche sans.
 */
interface Prefs {
  portalId: string | null;
  setPortal: (portalId: string) => void;
  /** Chaînes (`portail:chaîne`) en « direct au plus près » (LL-HLS) ; les autres en confort. */
  lowLatency: string[];
  toggleLowLatency: (channelKey: string) => void;
  /** Qualité maximale par réseau, et économie de données. */
  quality: QualityPrefs;
  setQualityPrefs: (change: Partial<QualityPrefs>) => void;
  /**
   * Langue de sous-titres choisie en dernier (code ISO 639 du fichier) : retrouvée d'un film
   * à l'autre. null : sans sous-titres.
   */
  subtitleLanguage: string | null;
  setSubtitleLanguage: (language: string | null) => void;
}

const PORTAL_KEY = 'lumen.portal';
const LOW_LATENCY_KEY = 'lumen.lowLatency';
const QUALITY_KEY = 'lumen.quality';
const SUBTITLES_KEY = 'lumen.subtitles';

function readQuality(): QualityPrefs {
  try {
    const parsed = JSON.parse(read(QUALITY_KEY) ?? '{}') as Partial<Record<keyof QualityPrefs, unknown>>;
    const profile = (v: unknown, fallback: QualityPrefs['wifi']): QualityPrefs['wifi'] =>
      QUALITY_ORDER.find((q) => q === v) ?? fallback;
    return {
      wifi: profile(parsed.wifi, DEFAULT_QUALITY_PREFS.wifi),
      cellular: profile(parsed.cellular, DEFAULT_QUALITY_PREFS.cellular),
      unknown: profile(parsed.unknown, DEFAULT_QUALITY_PREFS.unknown),
      dataSaver: parsed.dataSaver === true,
    };
  } catch {
    return DEFAULT_QUALITY_PREFS;
  }
}

function readList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(read(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Préférence perdue au rechargement, sans autre conséquence.
  }
}

export const usePrefs = create<Prefs>((set) => ({
  portalId: read(PORTAL_KEY),
  setPortal: (portalId) => {
    write(PORTAL_KEY, portalId);
    set({ portalId });
  },
  quality: readQuality(),
  setQualityPrefs: (change) => {
    set((s) => {
      const quality = { ...s.quality, ...change };
      write(QUALITY_KEY, JSON.stringify(quality));
      return { quality };
    });
  },
  subtitleLanguage: read(SUBTITLES_KEY),
  setSubtitleLanguage: (language) => {
    if (language === null) {
      try {
        window.localStorage.removeItem(SUBTITLES_KEY);
      } catch {
        // Rien à effacer.
      }
    } else write(SUBTITLES_KEY, language);
    set({ subtitleLanguage: language });
  },
  lowLatency: readList(LOW_LATENCY_KEY),
  toggleLowLatency: (channelKey) => {
    set((s) => {
      const lowLatency = s.lowLatency.includes(channelKey)
        ? s.lowLatency.filter((k) => k !== channelKey)
        : [...s.lowLatency, channelKey];
      write(LOW_LATENCY_KEY, JSON.stringify(lowLatency));
      return { lowLatency };
    });
  },
}));

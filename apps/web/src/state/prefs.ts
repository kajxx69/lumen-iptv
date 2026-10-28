import { create } from 'zustand';

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
}

const PORTAL_KEY = 'lumen.portal';
const LOW_LATENCY_KEY = 'lumen.lowLatency';

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

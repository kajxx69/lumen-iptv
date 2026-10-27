import { create } from 'zustand';

/**
 * Préférences propres à cet appareil (pas au compte) : le portail affiché. Le stockage
 * local peut être indisponible (navigation privée) : l'application marche sans.
 */
interface Prefs {
  portalId: string | null;
  setPortal: (portalId: string) => void;
}

const PORTAL_KEY = 'lumen.portal';

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
}));

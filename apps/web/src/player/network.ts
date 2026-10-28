/**
 * Réseau de l'appareil (API Network Information, PROJECT.md : adaptation au réseau). Absente
 * (Safari, Firefox), le réseau est « inconnu » et traité comme un WiFi : l'utilisateur garde
 * la main dans les Réglages.
 */

export type NetworkKind = 'wifi' | 'cellular' | 'unknown';

export interface NetworkInfo {
  kind: NetworkKind;
  /** Économie de données demandée par le système (en-tête Save-Data). */
  saveData: boolean;
  /** Réseau lent (2G, 3G) : le tampon de départ est renforcé. */
  slow: boolean;
}

/** Ce que l'on lit de navigator.connection (champs facultatifs selon les navigateurs). */
export interface ConnectionLike {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
}

const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g']);

export function readNetwork(connection: ConnectionLike | undefined): NetworkInfo {
  const type = connection?.type;
  const kind: NetworkKind =
    type === 'wifi' || type === 'ethernet' ? 'wifi' : type === 'cellular' ? 'cellular' : 'unknown';
  return {
    kind,
    saveData: connection?.saveData === true,
    slow: SLOW_EFFECTIVE_TYPES.has(connection?.effectiveType ?? ''),
  };
}

interface NavigatorWithConnection {
  connection?: ConnectionLike & EventTarget;
}

/** Le réseau en cours, et un abonnement à ses changements (passage du WiFi aux données mobiles). */
export function currentNetwork(): NetworkInfo {
  return readNetwork((navigator as NavigatorWithConnection).connection);
}

export function onNetworkChange(listener: () => void): () => void {
  const connection = (navigator as NavigatorWithConnection).connection;
  connection?.addEventListener('change', listener);
  window.addEventListener('online', listener);
  return () => {
    connection?.removeEventListener('change', listener);
    window.removeEventListener('online', listener);
  };
}

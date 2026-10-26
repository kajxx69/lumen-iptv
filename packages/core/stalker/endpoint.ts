import { StalkerError } from './errors.js';

export interface PortalLocation {
  /** Pages candidates pour l'API, dans l'ordre d'essai. */
  candidates: string[];
  /** Page d'accueil du lecteur MAG : envoyée en Referer, certains portails la vérifient. */
  referer: string;
}

const HTTP_URL = /^(https?:\/\/[^/?#]+)([^?#]*)/i;

/**
 * Les utilisateurs saisissent l'URL que leur fournisseur donne pour un boîtier MAG,
 * typiquement `http://hôte/c/` ou `http://hôte/stalker_portal/c/`. L'API se trouve à côté,
 * sous un nom qui varie selon le middleware : on essaie les emplacements connus.
 */
export function locatePortal(portalUrl: string): PortalLocation {
  const match = HTTP_URL.exec(portalUrl.trim());
  if (match === null)
    throw new StalkerError('invalid_config', 'URL de portail invalide (http:// ou https:// attendu)');
  const origin = match[1] ?? '';
  // Dossier de la page saisie (retire « index.html » éventuel), puis le dossier « c/ » du lecteur.
  const directory = (match[2] ?? '').replace(/[^/]*$/, '') || '/';
  const base = directory.replace(/(^|\/)c\/$/, '$1') || '/';
  const relative = [`${base}server/load.php`, `${base}portal.php`, `${base}c/portal.php`];
  const absolute = ['/stalker_portal/server/load.php', '/server/load.php', '/portal.php', '/c/portal.php'];
  const candidates = [...new Set([...relative, ...absolute].map((path) => `${origin}${path}`))];
  return { candidates, referer: `${origin}${base}c/` };
}

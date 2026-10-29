import type { StreamFormat } from '../sources/index.js';
import { StalkerError } from './errors.js';

// Toute URL absolue : http(s) surtout, mais certains portails servent du rtmp ou de l'udp.
const URL_IN_CMD = /[a-z][a-z0-9+.-]*:\/\/\S+/i;

/**
 * Extrait l'URL d'une commande create_link en retirant le préfixe parasite
 * (`ffmpeg `, `auto `, `ffrt `…) que les portails ajoutent pour leurs propres lecteurs.
 */
export function stripCmdPrefix(cmd: string): string {
  const match = URL_IN_CMD.exec(cmd);
  if (match === null) throw new StalkerError('invalid_response', 'commande de lecture sans URL exploitable');
  return match[0];
}

export function detectStreamFormat(url: string): StreamFormat {
  const extension = /[?&]extension=([^&#]+)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === 'm3u8') return 'hls';
  if (extension === 'ts') return 'ts';
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.ts')) return 'ts';
  return 'unknown';
}

/** URL sans sa requête : seule forme autorisée dans les journaux et les erreurs. */
export const redactUrl = (url: string): string => url.split(/[?#]/)[0] ?? '';

/** Hôtes qui disent « le portail fabriquera le lien » : la commande n'est pas jouable telle quelle. */
const PLACEHOLDER_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Lien de create_link recollé de travers. Sur les portails adossés à Xtream, la commande du
 * catalogue est déjà une adresse complète ; certains, à create_link, la recollent mal (un bout
 * de l'hôte au milieu, le chemin du catalogue à la fin, en double) et le serveur de flux
 * refuse (401). Le lien est jugé recollé quand, sur le même hôte, son chemin finit par celui
 * du catalogue sans lui être égal : la commande du catalogue est alors jouée telle quelle.
 * Dans tous les autres cas (lien sain, « localhost », autre serveur), le lien est gardé.
 */
export function repairLink(catalogCmd: string, linkUrl: string): string {
  const raw = URL_IN_CMD.exec(catalogCmd)?.[0];
  if (raw === undefined) return linkUrl;
  const catalog = splitUrl(raw);
  const link = splitUrl(linkUrl);
  if (catalog === null || link === null) return linkUrl;
  if (PLACEHOLDER_HOSTS.has(catalog.hostname) || catalog.hostname !== link.hostname) return linkUrl;
  const recolle = link.path !== catalog.path && catalog.path.length > 1 && link.path.endsWith(catalog.path);
  // Adresse du catalogue telle quelle (port compris) : c'est elle que jouent les boîtiers.
  return recolle ? raw : linkUrl;
}

/** schéma://hôte[:port]/chemin?requête : le cœur n'a pas l'objet URL (ni Node ni navigateur). */
const URL_PARTS = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)(?::\d+)?([^?#]*)/i;

function splitUrl(url: string): { hostname: string; path: string } | null {
  const m = URL_PARTS.exec(url);
  if (m?.[1] === undefined) return null;
  return { hostname: m[1].toLowerCase(), path: m[2] === undefined || m[2] === '' ? '/' : m[2] };
}

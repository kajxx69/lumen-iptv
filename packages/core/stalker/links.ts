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

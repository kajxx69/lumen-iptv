import type { FastifyReply } from 'fastify';
import { notFound } from '../http/errors.js';
import type { ActivePortal } from '../portals/registry.js';

export interface ImageProxyOptions {
  upstreamTimeoutMs: number;
  /** Cache navigateur : logos et affiches changent rarement et coûtent des données mobiles. */
  cacheMaxAgeS: number;
}

/**
 * Image d'un portail (logo, affiche) relayée par Lumen : le navigateur ne voit jamais
 * l'adresse du portail. `image` : chemin seul s'il vient du portail, URL complète sinon.
 */
export async function sendPortalImage(
  reply: FastifyReply,
  portal: ActivePortal,
  image: string,
  what: string,
  options: ImageProxyOptions,
): Promise<FastifyReply> {
  const url = image.startsWith('/') ? `${portal.origin}${image}` : image;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': portal.userAgent },
      signal: AbortSignal.timeout(options.upstreamTimeoutMs),
    });
  } catch {
    throw notFound(what);
  }
  const type = res.headers.get('content-type') ?? '';
  // Seules des images passent : le relais d'images ne doit pas servir n'importe quel contenu.
  if (!res.ok || !type.startsWith('image/')) throw notFound(what);
  return reply
    .header('Content-Type', type)
    .header('Cache-Control', `private, max-age=${options.cacheMaxAgeS}`)
    .send(Buffer.from(await res.arrayBuffer()));
}

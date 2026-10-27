import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { notFound } from '../http/errors.js';

// Sans build de l'interface (développement du backend seul) : page minimale, sans script.
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen</title></head>
<body><h1>Lumen</h1><p>Le serveur fonctionne. Construisez l’interface : pnpm --filter @lumen/web build.</p></body></html>`;
/** Dossier des fichiers de build, dont le nom porte une empreinte du contenu. */
const HASHED_ASSETS_DIR = '/assets/';
/**
 * Un fichier à empreinte ne change jamais : un an de cache, des données mobiles
 * économisées à chaque ouverture.
 */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Interface web servie par le backend, sur la même origine que l'API : cookie SameSite
 * strict, CSP `'self'`, aucun CORS. Une route inconnue hors /api renvoie l'application
 * (navigation côté client).
 */
export async function registerWebRoutes(app: FastifyInstance, webRoot: string): Promise<void> {
  const index = join(webRoot, 'index.html');
  if (!existsSync(index)) {
    app.get('/', (_req, reply) => reply.type('text/html; charset=utf-8').send(PLACEHOLDER_HTML));
    return;
  }
  const html = await readFile(index, 'utf8');
  await app.register(fastifyStatic, {
    root: webRoot,
    index: false,
    wildcard: false,
    setHeaders: (res, path) => {
      if (path.replaceAll('\\', '/').includes(HASHED_ASSETS_DIR))
        res.setHeader('Cache-Control', ASSET_CACHE_CONTROL);
    },
  });
  // L'enveloppe HTML est toujours revalidée : elle désigne les fichiers de la version courante.
  const sendApp = (reply: FastifyReply): FastifyReply =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
  app.get('/', (_req, reply) => sendApp(reply));
  app.get('/*', (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    // Une ressource d'API ou un fichier absent reste une vraie 404.
    if (path.startsWith('/api/') || path === '/metrics' || /\.\w+$/.test(path)) throw notFound('ressource');
    return sendApp(reply);
  });
}

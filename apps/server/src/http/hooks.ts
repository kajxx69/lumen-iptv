import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

const gzipAsync = promisify(gzip);

/**
 * CSP stricte : aucun script en ligne ni `eval`. `blob:` pour les workers et la lecture
 * (hls.js et mpegts.js passent par MediaSource et des workers).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// En dessous, la compression coûte plus qu'elle ne rapporte.
const GZIP_MIN_BYTES = 1024;
const COMPRESSIBLE = /^(application\/(json|vnd\.apple\.mpegurl)|text\/)/;

export function installHttpHooks(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    // Réponses d'API privées par défaut ; une route peut autoriser le cache (logos).
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control'))
      reply.header('Cache-Control', 'no-store');

    // Compression des réponses texte : sur réseau mobile, chaque octet compte.
    const isText = typeof payload === 'string' || Buffer.isBuffer(payload);
    const type = String(reply.getHeader('content-type') ?? '');
    const accepts = (req.headers['accept-encoding'] ?? '').includes('gzip');
    if (!isText || !COMPRESSIBLE.test(type) || reply.hasHeader('content-encoding')) return payload;
    reply.header('Vary', 'Accept-Encoding');
    if (!accepts || Buffer.byteLength(payload) < GZIP_MIN_BYTES) return payload;
    reply.header('Content-Encoding', 'gzip');
    reply.removeHeader('content-length');
    return gzipAsync(payload);
  });
}

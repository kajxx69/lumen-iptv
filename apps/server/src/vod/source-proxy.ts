import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import type { UpstreamLink } from '../relay/upstream.js';

const ID_BYTES = 16;
/**
 * Pause avant une reprise : 250 ms, puis le double à chaque échec, 1 s au plus. Une seconde
 * au plus perdue après le retour du portail ; quelques requêtes de plus pendant la panne.
 */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 1000;
/** Réponses qui disent « ce lien ne vaut plus » : un nouveau lien est demandé au portail. */
const LINK_EXPIRED_STATUSES = new Set([401, 403, 404, 410]);
const RANGE_HEADER = /^bytes=(\d+)-(\d*)$/;
const CONTENT_RANGE_TOTAL = /\/(\d+)$/;

export interface VodSourceProxyOptions {
  /** Attente des en-têtes d'une réponse du portail. */
  connectTimeoutMs: number;
  /** Le fichier ne répond plus : nouvelles tentatives pendant ce délai, puis abandon. */
  retryDeadlineMs: number;
}

export interface VodSourceStats {
  /** Reprises après une coupure, une fois le fichier commencé. */
  resumes: number;
  /** Liens demandés au portail (le premier compris). */
  links: number;
}

/** Un fichier de film servi sur la boucle locale, à une adresse qui ne dit rien de lui. */
export interface VodSource {
  readonly url: string;
  readonly stats: VodSourceStats;
  close(): void;
}

interface Entry {
  resolve: () => Promise<UpstreamLink>;
  link: UpstreamLink | null;
  closed: boolean;
  requests: Set<AbortController>;
  stats: VodSourceStats;
}

/** Échec passager : on réessaie, depuis l'octet où l'on s'est arrêté. */
class Retryable extends Error {}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const drained = (res: ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });

/** Taille totale du fichier d'après la réponse (Content-Range, ou Content-Length d'un 200). */
function totalSize(res: Response): number | null {
  const range = CONTENT_RANGE_TOTAL.exec(res.headers.get('content-range') ?? '');
  if (range?.[1] !== undefined) return Number(range[1]);
  const length = res.headers.get('content-length');
  return res.status === 200 && length !== null ? Number(length) : null;
}

/**
 * Relais local entre FFmpeg et le fichier d'un film chez le portail. FFmpeg lit une adresse
 * de boucle locale opaque : ni jeton, ni MAC, ni adresse du portail dans ses arguments ou
 * ses messages d'erreur. Le relais envoie les en-têtes du boîtier imité, et surtout rend
 * la lecture insensible aux coupures : une connexion rompue reprend à l'octet près (Range),
 * un lien expiré est redemandé au portail, un serveur qui ignore Range est relu depuis le
 * début en sautant ce qui est déjà transmis. FFmpeg ne voit qu'un fichier qui arrive.
 */
export class VodSourceProxy {
  private server: Server | null = null;
  private base = '';
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: VodSourceProxyOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /**
   * Nouveau fichier servi. `initial` : lien déjà obtenu (l'appelant a voulu voir tout de
   * suite une erreur du portail) ; `resolve` en redemande un quand il expire.
   */
  open(resolve: () => Promise<UpstreamLink>, initial?: UpstreamLink): VodSource {
    if (this.server === null) throw new Error('relais local non démarré');
    const id = randomBytes(ID_BYTES).toString('hex');
    const entry: Entry = {
      resolve,
      link: initial ?? null,
      closed: false,
      requests: new Set(),
      stats: { resumes: 0, links: initial === undefined ? 0 : 1 },
    };
    this.entries.set(id, entry);
    return {
      url: `${this.base}/${id}`,
      stats: entry.stats,
      close: () => {
        entry.closed = true;
        for (const c of entry.requests) c.abort();
        this.entries.delete(id);
      },
    };
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) for (const c of entry.requests) c.abort();
    this.entries.clear();
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry = this.entries.get((req.url ?? '').slice(1));
    if (entry === undefined || entry.closed || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const range = RANGE_HEADER.exec(req.headers.range ?? '');
    const controller = new AbortController();
    entry.requests.add(controller);
    res.on('close', () => {
      controller.abort();
    });
    try {
      await this.pump(entry, res, controller.signal, {
        head: req.method === 'HEAD',
        ranged: range !== null,
        first: range === null ? 0 : Number(range[1]),
        last: range?.[2] === undefined || range[2] === '' ? null : Number(range[2]),
      });
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : 'inconnue' },
        'fichier du film perdu malgré les reprises',
      );
      if (!res.headersSent) res.writeHead(502).end();
      // Réponse tronquée : FFmpeg voit la fin du fichier, il n'attend pas indéfiniment.
      else res.destroy();
    } finally {
      entry.requests.delete(controller);
    }
  }

  private async pump(
    entry: Entry,
    res: ServerResponse,
    signal: AbortSignal,
    request: { head: boolean; ranged: boolean; first: number; last: number | null },
  ): Promise<void> {
    /** Prochain octet à transmettre ; dernier octet voulu (inclus), connu dès la première réponse. */
    let offset = request.first;
    let end = request.last;
    let started = false;
    let failingSince: number | null = null;
    let pause = RETRY_INITIAL_MS;
    // Relu à chaque fois : le spectateur peut s'en aller pendant n'importe quelle attente.
    const aborted = (): boolean => signal.aborted;
    for (;;) {
      if (aborted()) return;
      try {
        if (entry.link === null) {
          entry.link = await entry.resolve();
          entry.stats.links++;
        }
        const wanted = offset > 0 || end !== null ? `bytes=${offset}-${end ?? ''}` : null;
        const up = await this.fetchUpstream(entry.link, wanted, signal);
        if (LINK_EXPIRED_STATUSES.has(up.status)) {
          await up.body?.cancel().catch(() => undefined);
          entry.link = null;
          throw new Retryable(`HTTP ${up.status}`);
        }
        if (up.status === 416) {
          await up.body?.cancel().catch(() => undefined);
          if (!started) res.writeHead(416, { 'Content-Range': up.headers.get('content-range') ?? '' });
          res.end();
          return;
        }
        if (!up.ok || up.body === null) {
          await up.body?.cancel().catch(() => undefined);
          throw new Retryable(`HTTP ${up.status}`);
        }
        // Serveur qui ignore Range : il renvoie tout depuis le début ; on saute le déjà-transmis.
        let skip = wanted !== null && up.status !== 206 ? offset : 0;
        if (!started) {
          started = true;
          const total = totalSize(up);
          if (end === null && total !== null) end = total - 1;
          const headers: Record<string, string | number> = {
            'Content-Type': up.headers.get('content-type') ?? 'application/octet-stream',
          };
          // Tranches promises seulement si l'on sait en servir (taille connue).
          if (total !== null) headers['Accept-Ranges'] = 'bytes';
          if (end !== null) headers['Content-Length'] = end - request.first + 1;
          if (request.ranged && end !== null && total !== null) {
            headers['Content-Range'] = `bytes ${request.first}-${end}/${total}`;
            res.writeHead(206, headers);
          } else res.writeHead(200, headers);
          if (request.head) {
            await up.body.cancel().catch(() => undefined);
            res.end();
            return;
          }
        }
        const reader = (up.body as ReadableStream<Uint8Array>).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            let chunk = value;
            if (skip > 0) {
              if (chunk.length <= skip) {
                skip -= chunk.length;
                continue;
              }
              chunk = chunk.subarray(skip);
              skip = 0;
            }
            if (end !== null && offset + chunk.length > end + 1) chunk = chunk.subarray(0, end + 1 - offset);
            if (chunk.length === 0) break;
            offset += chunk.length;
            failingSince = null;
            pause = RETRY_INITIAL_MS;
            // FFmpeg en pause (le lecteur a assez d'avance) : on cesse de lire le portail aussi.
            if (!res.write(chunk)) await drained(res);
            if (aborted() || (end !== null && offset > end)) break;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        if (aborted()) return;
        // Taille inconnue : la fin du corps est la fin du fichier.
        if (end === null || offset > end) {
          res.end();
          return;
        }
        throw new Retryable('fichier interrompu');
      } catch (err) {
        if (aborted()) return;
        failingSince ??= Date.now();
        if (Date.now() - failingSince + pause > this.options.retryDeadlineMs) throw err;
        if (started) entry.stats.resumes++;
        this.log.info(
          { offset, reason: err instanceof Error ? err.message : 'inconnue' },
          'fichier du film interrompu : reprise',
        );
        await sleep(pause, signal);
        pause = Math.min(pause * 2, RETRY_MAX_MS);
      }
    }
  }

  /** Le délai ne couvre que l'attente des en-têtes : un film se lit pendant des heures. */
  private async fetchUpstream(
    link: UpstreamLink,
    range: string | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, this.options.connectTimeoutMs);
    try {
      return await fetch(link.url, {
        headers: { 'User-Agent': link.userAgent, Accept: '*/*', ...(range === null ? {} : { Range: range }) },
        signal: AbortSignal.any([signal, timeout.signal]),
      });
    } catch {
      // Le message d'erreur de fetch peut citer l'adresse : on ne le garde pas.
      throw new Retryable('portail injoignable');
    } finally {
      clearTimeout(timer);
    }
  }
}

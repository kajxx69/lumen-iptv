import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UpstreamLink } from '../src/relay/upstream.js';
import { VodSourceProxy } from '../src/vod/source-proxy.js';

const FILE = randomBytes(1024 * 1024);
const USER_AGENT = 'Mozilla/5.0 (QtEmbedded; MAG250) test';

interface UpstreamBehaviour {
  /** Coupe la connexion après ce nombre d'octets, pour les `cuts` premières réponses. */
  cutAfter?: number;
  cuts?: number;
  /** Le serveur ignore l'en-tête Range (réponse 200 complète à chaque fois). */
  ignoreRanges?: boolean;
  /** Après la première coupure, le jeton du lien est refusé (403) : il faut un nouveau lien. */
  expireAfterCut?: boolean;
  /** Plus aucune réponse après la première coupure. */
  deadAfterCut?: boolean;
}

/** Serveur de fichiers d'un portail : Range, coupures, jetons qui expirent. */
class FakeUpstream {
  behaviour: UpstreamBehaviour = {};
  requests: { range: string | undefined; userAgent: string | undefined; token: string }[] = [];
  /** Jeton accepté ; le test le change pour imiter un nouveau create_link. */
  validToken = 'jeton-1';
  baseUrl = '';
  private server: Server | null = null;
  private cutsDone = 0;

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  reset(behaviour: UpstreamBehaviour): void {
    this.behaviour = behaviour;
    this.requests = [];
    this.cutsDone = 0;
    this.validToken = 'jeton-1';
  }

  /** Nouveau lien, comme create_link : un nouveau jeton. */
  link(token: string): UpstreamLink {
    return { url: `${this.baseUrl}/movie.ts?play_token=${token}`, format: 'ts', userAgent: USER_AGENT };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const token = new URL(req.url ?? '/', this.baseUrl).searchParams.get('play_token') ?? '';
    this.requests.push({ range: req.headers.range, userAgent: req.headers['user-agent'], token });
    const b = this.behaviour;
    if (b.deadAfterCut === true && this.cutsDone > 0) {
      req.socket.destroy();
      return;
    }
    if (token !== this.validToken) {
      res.writeHead(403).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = FILE.length - 1;
    let status = 200;
    const headers: Record<string, string | number> = { 'Content-Type': 'video/mp2t' };
    if (range !== null && b.ignoreRanges !== true) {
      start = Number(range[1]);
      end = range[2] === '' ? end : Math.min(Number(range[2]), end);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${FILE.length}`;
    }
    if (b.ignoreRanges !== true) headers['Accept-Ranges'] = 'bytes';
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    const body = FILE.subarray(start, end + 1);
    if (b.cutAfter !== undefined && this.cutsDone < (b.cuts ?? 1)) {
      this.cutsDone++;
      if (b.expireAfterCut === true) this.validToken = 'jeton-expiré';
      res.write(body.subarray(0, b.cutAfter), () => {
        res.socket?.destroy();
      });
      return;
    }
    res.end(body);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

async function readAll(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

describe('relais local du fichier d un film (lu par FFmpeg)', () => {
  const upstream = new FakeUpstream();
  const proxy = new VodSourceProxy(
    { connectTimeoutMs: 2000, retryDeadlineMs: 3000 },
    pino({ level: 'silent' }),
  );
  let resolveCount = 0;
  const resolveLink = (): Promise<UpstreamLink> => {
    resolveCount++;
    return Promise.resolve(upstream.link(resolveCount === 1 ? 'jeton-1' : `jeton-${resolveCount}`));
  };

  beforeAll(async () => {
    await upstream.start();
    await proxy.listen();
  });
  afterAll(async () => {
    await proxy.close();
    await upstream.close();
  });
  afterEach(() => {
    resolveCount = 0;
  });

  it('sert le fichier entier ; l adresse locale ne porte ni jeton ni adresse du portail', async () => {
    upstream.reset({});
    const source = proxy.open(resolveLink);
    expect(source.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(source.url).not.toContain('jeton');
    const { status, body } = await readAll(source.url);
    expect(status).toBe(200);
    expect(body.equals(FILE)).toBe(true);
    expect(upstream.requests[0]?.userAgent).toBe(USER_AGENT);
    source.close();
  });

  it('requête Range : la tranche demandée, avec Content-Range', async () => {
    upstream.reset({});
    const source = proxy.open(resolveLink);
    const { status, body, headers } = await readAll(source.url, { Range: 'bytes=1000-1999' });
    expect(status).toBe(206);
    expect(headers.get('content-range')).toBe(`bytes 1000-1999/${FILE.length}`);
    expect(body.equals(FILE.subarray(1000, 2000))).toBe(true);
    source.close();
  });

  it('connexion coupée en plein fichier : reprise à l octet près, invisible pour FFmpeg', async () => {
    upstream.reset({ cutAfter: 300_000, cuts: 2 });
    const source = proxy.open(resolveLink);
    const { status, body } = await readAll(source.url);
    expect(status).toBe(200);
    expect(body.equals(FILE)).toBe(true);
    const last = FILE.length - 1;
    expect(upstream.requests.map((r) => r.range)).toEqual([
      undefined,
      `bytes=300000-${last}`,
      `bytes=600000-${last}`,
    ]);
    expect(source.stats.resumes).toBe(2);
    source.close();
  });

  it('lien expiré après la coupure : nouveau lien demandé au portail, reprise au même octet', async () => {
    upstream.reset({ cutAfter: 200_000, expireAfterCut: true });
    let calls = 0;
    const source = proxy.open(() => {
      calls++;
      // Le portail donne un nouveau jeton, que le faux serveur accepte désormais.
      const token = calls === 1 ? 'jeton-1' : 'jeton-neuf';
      upstream.validToken = token;
      return Promise.resolve(upstream.link(token));
    });
    const { body } = await readAll(source.url);
    expect(body.equals(FILE)).toBe(true);
    expect(calls).toBe(2);
    expect(upstream.requests.at(-1)).toMatchObject({
      range: `bytes=200000-${FILE.length - 1}`,
      token: 'jeton-neuf',
    });
    source.close();
  });

  it('serveur sans Range : la reprise relit depuis le début et saute ce qui est déjà transmis', async () => {
    upstream.reset({ cutAfter: 400_000, ignoreRanges: true });
    const source = proxy.open(resolveLink);
    const { body } = await readAll(source.url);
    expect(body.equals(FILE)).toBe(true);
    expect(source.stats.resumes).toBe(1);
    source.close();
  });

  it('fichier définitivement perdu : la réponse s arrête après le délai de reprise, sans attendre plus', async () => {
    upstream.reset({ cutAfter: 100_000, deadAfterCut: true });
    const source = proxy.open(resolveLink);
    const started = Date.now();
    const res = await fetch(source.url);
    const read = await res.arrayBuffer().then(
      (b) => b.byteLength,
      () => -1,
    );
    // Réponse tronquée (ou rompue) : FFmpeg verra la fin du fichier, pas une attente sans fin.
    expect(read === -1 || read < FILE.length).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000 + 2500);
    source.close();
  });

  it('identifiant inconnu ou source fermée : 404', async () => {
    upstream.reset({});
    const source = proxy.open(resolveLink);
    source.close();
    expect((await fetch(source.url)).status).toBe(404);
    expect((await fetch(source.url.replace(/[0-9a-f]{32}$/, '0'.repeat(32)))).status).toBe(404);
  });
});

import { spawn } from 'node:child_process';
import { type ClientRequest, type IncomingMessage, request } from 'node:http';
import { configFromEnv, type FakePortalConfigInput } from '../src/config.js';
import { type MediaAssets, loadMediaAssets } from '../src/media/assets.js';
import {
  MPEG_TICKS_PER_MS,
  TS_PACKET_SIZE,
  TS_SYNC_BYTE,
  isVideoStream,
  pesTimestampsAt,
  readHeader,
  readTimestamp,
} from '../src/media/mpegts.js';
import { type FakePortal, createFakePortal } from '../src/server.js';

export const MAG250_UA =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
export const TEST_MAC = '00:1A:79:00:00:01';
export const DEFAULT_ENTRYPOINT = '/stalker_portal/server/load.php';
/** Une image à 25 i/s = 40 ms = 3 600 ticks à 90 kHz. */
export const FRAME_TICKS = 40 * MPEG_TICKS_PER_MS;

const envConfig = configFromEnv(process.env);
let assetsPromise: Promise<MediaAssets> | undefined;
export const sharedAssets = (): Promise<MediaAssets> =>
  (assetsPromise ??= loadMediaAssets(envConfig.media, envConfig.assetDir, envConfig.ffmpegPath));

export interface RunningPortal extends FakePortal {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startPortal(overrides: FakePortalConfigInput = {}): Promise<RunningPortal> {
  const portal = await createFakePortal(
    { host: '127.0.0.1', port: 0, logLevel: 'silent', ...overrides },
    { assets: await sharedAssets() },
  );
  await portal.app.listen({ host: '127.0.0.1', port: 0 });
  const address = portal.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('adresse inattendue');
  return { ...portal, baseUrl: `http://127.0.0.1:${address.port}`, close: () => portal.app.close() };
}

export interface ApiResponse<T> {
  status: number;
  body: { js: T; text?: string };
}

/** Client Stalker minimal, propre aux tests : le vrai client arrive en phase 1. */
export class StalkerTestClient {
  token: string | undefined;

  constructor(
    readonly baseUrl: string,
    readonly mac = TEST_MAC,
    readonly model = 'MAG250',
    readonly entrypoint = DEFAULT_ENTRYPOINT,
  ) {}

  headers(): Record<string, string> {
    return {
      Cookie: `mac=${encodeURIComponent(this.mac)}; stb_lang=fr; timezone=Africa%2FAbidjan`,
      'User-Agent': MAG250_UA,
      'X-User-Agent': `Model: ${this.model}; Link: WiFi`,
      Referer: `${this.baseUrl}/c/`,
      ...(this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` }),
    };
  }

  async raw<T>(params: Record<string, string | number>): Promise<ApiResponse<T>> {
    const qs = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      JsHttpRequest: '1-xml',
    });
    const res = await fetch(`${this.baseUrl}${this.entrypoint}?${qs.toString()}`, {
      headers: this.headers(),
    });
    return { status: res.status, body: (await res.json()) as ApiResponse<T>['body'] };
  }

  async call<T>(type: string, action: string, params: Record<string, string | number> = {}): Promise<T> {
    const res = await this.raw<T>({ type, action, ...params });
    if (res.status !== 200) throw new Error(`${type}/${action} → HTTP ${res.status} ${res.body.text ?? ''}`);
    return res.body.js;
  }

  async handshake(): Promise<string> {
    this.token = undefined;
    const js = await this.call<{ token: string }>('stb', 'handshake', { token: '' });
    this.token = js.token;
    return js.token;
  }

  /** URL de lecture d'une chaîne, préfixe parasite (`ffmpeg `, `auto `) retiré. */
  async liveUrl(channelId: number): Promise<string> {
    const js = await this.call<{ cmd: string; error: string }>('itv', 'create_link', {
      cmd: `ffmpeg http://localhost/ch/${channelId}_`,
    });
    return stripPrefix(js.cmd);
  }
}

export const stripPrefix = (cmd: string): string => cmd.replace(/^(ffmpeg|auto)\s+/, '');

export async function chaos(
  baseUrl: string,
  scenario: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/_chaos/${scenario}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`chaos ${scenario} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export interface VideoSample {
  /** Instant d'arrivée côté client (horloge murale, comparable aux fenêtres de chaos). */
  at: number;
  pts: number;
}

/**
 * Lecture d'un flux TS telle que la voit un client : octets reçus horodatés et PTS
 * vidéo extraits au fil de l'eau.
 */
export class TsCapture {
  readonly arrivals: { at: number; bytes: number }[] = [];
  readonly video: VideoSample[] = [];
  bytes = 0;
  syncErrors = 0;
  firstByteAt: number | undefined;
  closedAt: number | undefined;
  private rest = Buffer.alloc(0);
  private closeWaiters: (() => void)[] = [];

  private constructor(
    readonly openedAt: number,
    readonly response: IncomingMessage,
    private readonly req: ClientRequest,
  ) {
    response.on('data', (chunk: Buffer) => this.onData(chunk));
    const onClose = (): void => {
      this.closedAt ??= Date.now();
      for (const w of this.closeWaiters) w();
      this.closeWaiters = [];
    };
    response.on('close', onClose);
    response.on('error', onClose);
    req.on('error', onClose);
  }

  static open(url: string): Promise<TsCapture> {
    return new Promise((resolve, reject) => {
      const openedAt = Date.now();
      const req = request(url, (res) => resolve(new TsCapture(openedAt, res, req)));
      req.on('error', reject);
      req.end();
    });
  }

  get status(): number {
    return this.response.statusCode ?? 0;
  }

  private onData(chunk: Buffer): void {
    const now = Date.now();
    this.firstByteAt ??= now;
    this.bytes += chunk.length;
    this.arrivals.push({ at: now, bytes: chunk.length });
    const buf = this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk;
    let off = 0;
    for (; off + TS_PACKET_SIZE <= buf.length; off += TS_PACKET_SIZE) {
      if (buf[off] !== TS_SYNC_BYTE) {
        this.syncErrors++;
        continue;
      }
      const header = readHeader(buf, off);
      const pes = pesTimestampsAt(buf, off, header);
      if (pes?.ptsAt != null && isVideoStream(pes.streamId)) {
        this.video.push({ at: now, pts: readTimestamp(buf, pes.ptsAt) });
      }
    }
    this.rest = Buffer.from(buf.subarray(off));
  }

  bytesBetween(from: number, to: number): number {
    return this.arrivals.filter((a) => a.at >= from && a.at < to).reduce((s, a) => s + a.bytes, 0);
  }

  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closedAt !== undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): void {
    this.req.destroy();
  }
}

/** Résultat d'une tentative de connexion de flux : réponse HTTP ou erreur de socket. */
export function tryConnect(url: string): Promise<{ status: number } | { error: string }> {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      resolve({ status: res.statusCode ?? 0 });
      req.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
    req.end();
  });
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lance FFmpeg sur un fichier TS et renvoie sa sortie d'erreur (où les filtres journalisent). */
export function ffmpegAnalyze(input: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      envConfig.ffmpegPath,
      ['-hide_banner', '-nostats', '-i', input, ...args, '-f', 'null', '-'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(stderr));
  });
}

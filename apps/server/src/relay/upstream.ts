import { type MediaPlaylist, PlaylistError, parsePlaylist, pickVariant } from './hls-parser.js';

/** Lien amont résolu (create_link) : jamais journalisé ni renvoyé au client. */
export interface UpstreamLink {
  url: string;
  format: 'ts' | 'hls' | 'unknown';
  userAgent: string;
}

/** Destination des octets amont : le découpeur du relais. */
export interface UpstreamSink {
  data(bytes: Uint8Array): void;
  /** Rupture dans la source elle-même (discontinuité HLS amont, retard rattrapé). */
  discontinuity(): void;
  /** Segment amont introuvable dans le délai : sauté, avec une rupture à sa place. */
  skipped(): void;
}

export interface UpstreamOptions {
  /** Délai d'obtention des en-têtes d'une réponse amont. */
  connectTimeoutMs: number;
  /** Un segment HLS amont introuvable est réessayé jusqu'à ce délai, puis sauté. */
  hlsSegmentRetryDeadlineMs: number;
  /** Segments déjà publiés repris à l'ouverture d'une source HLS : du tampon tout de suite. */
  hlsInitialBacklogSegments: number;
}

export type UpstreamErrorKind = 'http' | 'network' | 'invalid' | 'unsupported';

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Pause entre deux essais d'un même segment HLS manquant. */
const SEGMENT_RETRY_PAUSE_MS = 250;
/** Un segment amont plus gros est anormal (≈ 2 min de HD) : protège la mémoire du relais. */
const MAX_UPSTREAM_SEGMENT_BYTES = 64 * 1024 * 1024;
const HLS_SIGNATURE = '#EXTM3U';
const MS_PER_S = 1000;

/**
 * Lit une source amont jusqu'à sa fin (résolution normale) ou une panne (rejet).
 * L'abandon du signal (bascule, gel, fermeture) interrompt tout, y compris les attentes.
 */
export async function readUpstream(
  link: UpstreamLink,
  sink: UpstreamSink,
  signal: AbortSignal,
  options: UpstreamOptions,
): Promise<void> {
  const res = await open(link.url, link.userAgent, signal, options.connectTimeoutMs);
  const type = res.headers.get('content-type') ?? '';
  if (link.format === 'hls' || type.includes('mpegurl')) {
    const text = await res.text().catch((err: unknown) => {
      throw toUpstreamError(err);
    });
    return readHls(text, res.url, link, sink, signal, options);
  }
  if (res.body === null) throw new UpstreamError('invalid', 'réponse amont sans corps');
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // Lien sans extension reconnaissable : une playlist se reconnaît à sa signature.
      if (first && link.format === 'unknown' && startsWithSignature(value)) {
        const parts = [value];
        for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
        await readHls(Buffer.concat(parts).toString('utf8'), res.url, link, sink, signal, options);
        return;
      }
      first = false;
      sink.data(value);
    }
  } catch (err) {
    throw toUpstreamError(err);
  } finally {
    reader.releaseLock();
  }
}

const startsWithSignature = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes.subarray(0, HLS_SIGNATURE.length)) === HLS_SIGNATURE;

async function open(
  url: string,
  userAgent: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  // Le délai ne couvre que l'attente des en-têtes : un flux en direct ne « finit » jamais.
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: '*/*' },
      signal: AbortSignal.any([signal, timeout.signal]),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError('http', `HTTP ${res.status}`, res.status);
    }
    return res;
  } catch (err) {
    throw toUpstreamError(err);
  } finally {
    clearTimeout(timer);
  }
}

function toUpstreamError(err: unknown): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (err instanceof PlaylistError) return new UpstreamError('invalid', err.message);
  // Message générique : celui d'undici peut contenir l'URL amont (et son token).
  return new UpstreamError('network', 'connexion amont interrompue');
}

async function fetchPlaylist(
  url: string,
  link: UpstreamLink,
  signal: AbortSignal,
  options: UpstreamOptions,
): Promise<MediaPlaylist> {
  const res = await open(url, link.userAgent, signal, options.connectTimeoutMs);
  try {
    const parsed = parsePlaylist(await res.text(), res.url);
    if (parsed.kind === 'master') throw new UpstreamError('unsupported', 'playlist maîtresse imbriquée');
    return parsed;
  } catch (err) {
    throw toUpstreamError(err);
  }
}

async function readHls(
  text: string,
  url: string,
  link: UpstreamLink,
  sink: UpstreamSink,
  signal: AbortSignal,
  options: UpstreamOptions,
): Promise<void> {
  let playlistUrl = url;
  let parsed;
  try {
    parsed = parsePlaylist(text, url);
  } catch (err) {
    throw toUpstreamError(err);
  }
  if (parsed.kind === 'master') {
    const variant = pickVariant(parsed.variants);
    if (variant === undefined) throw new UpstreamError('invalid', 'playlist maîtresse sans variante');
    playlistUrl = variant.uri;
    parsed = await fetchPlaylist(playlistUrl, link, signal, options);
  }
  let media: MediaPlaylist = parsed;
  if (media.initSegment) throw new UpstreamError('unsupported', 'segments fMP4 amont pas encore relayés');

  let nextSeq: number | null = null;
  for (;;) {
    const loadedAt = Date.now();
    const last = media.segments.at(-1)?.seq ?? media.mediaSequence - 1;
    if (nextSeq === null) {
      nextSeq = Math.max(media.mediaSequence, last - options.hlsInitialBacklogSegments + 1);
    } else if (nextSeq < media.mediaSequence) {
      // Segments sortis de la fenêtre amont avant d'avoir été lus : trou dans le flux.
      sink.discontinuity();
      nextSeq = media.mediaSequence;
    }
    let fresh = false;
    for (const segment of media.segments) {
      if (segment.seq < nextSeq) continue;
      if (segment.discontinuity && fresh) sink.discontinuity();
      const bytes = await fetchSegmentBytes(segment.uri, link, signal, options);
      if (bytes === null)
        sink.skipped(); // Sauté plutôt que de bloquer la playlist.
      else sink.data(bytes);
      nextSeq = segment.seq + 1;
      fresh = true;
    }
    if (media.endList) return;
    // RFC 8216 §6.3.4 : recharger après la durée cible, la moitié si rien n'a changé.
    const intervalMs = (media.targetDurationS * MS_PER_S) / (fresh ? 1 : 2);
    await sleep(intervalMs - (Date.now() - loadedAt), signal);
    media = await fetchPlaylist(playlistUrl, link, signal, options);
  }
}

async function fetchSegmentBytes(
  uri: string,
  link: UpstreamLink,
  signal: AbortSignal,
  options: UpstreamOptions,
): Promise<Uint8Array | null> {
  const deadline = Date.now() + options.hlsSegmentRetryDeadlineMs;
  for (;;) {
    try {
      const res = await open(uri, link.userAgent, signal, options.connectTimeoutMs);
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > MAX_UPSTREAM_SEGMENT_BYTES) throw new UpstreamError('invalid', 'segment amont démesuré');
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (signal.aborted) throw toUpstreamError(err);
      // Lien refusé : inutile d'insister, c'est une panne de la source.
      const e = toUpstreamError(err);
      if (e.kind === 'http' && (e.status === 401 || e.status === 403)) throw e;
      if (Date.now() + SEGMENT_RETRY_PAUSE_MS > deadline) return null;
      await sleep(SEGMENT_RETRY_PAUSE_MS, signal);
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UpstreamError('network', 'abandon'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new UpstreamError('network', 'abandon'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

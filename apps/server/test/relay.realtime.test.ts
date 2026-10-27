import type { PlaybackDto, PortalDto } from '@lumen/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfigInput } from '../src/config.js';
import type { MediaSegment } from '../src/relay/hls-parser.js';
import {
  type RunningPortal,
  type TestServer,
  activeStreams,
  addPortal,
  decodeErrors,
  delay,
  fetchSegment,
  readPlaylist,
  sendChaos,
  startPlayback,
  startPortal,
  startServer,
  waitFor,
} from './helpers.js';

/**
 * Relais en conditions réelles : faux portails cadencés en temps réel, pannes injectées
 * par l'API de chaos. Chaque test mesure ce que verrait un lecteur : la playlist et ses
 * segments, toujours à la même URL.
 */

const CHANNEL = '1';
/** La même chaîne sur le portail B : les identifiants y partent de 100 000 (graine 2). */
const CHANNEL_ON_B = '100001';
/** Critère PROJECT.md : bascule entre sources en moins de 2 s. */
const MAX_SWITCH_MS = 2000;

interface Dual {
  a: RunningPortal;
  b: RunningPortal;
  srv: TestServer;
  dtoA: PortalDto;
  dtoB: PortalDto;
}

let opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const o of opened.reverse()) await o.close().catch(() => undefined);
  opened = [];
});

async function dual(
  server: Partial<ServerConfigInput> = {},
  streamFormat: 'ts' | 'm3u8' = 'ts',
): Promise<Dual> {
  const a = await startPortal({ channelCount: 50, streamFormat });
  const b = await startPortal({ channelCount: 50, streamFormat, seed: 2, portalName: 'Portail B' });
  const srv = await startServer(server);
  opened.push(a, b, srv);
  const dtoA = await addPortal(srv.admin, a, { name: 'Portail A' });
  const dtoB = await addPortal(srv.admin, b, { name: 'Portail B', mac: '00:1A:79:AB:CD:EE' });
  return { a, b, srv, dtoA, dtoB };
}

const play = (d: Dual, withFallback: boolean, channelId = CHANNEL): Promise<PlaybackDto> =>
  startPlayback(d.srv.admin, {
    portalId: d.dtoA.id,
    channelId,
    ...(withFallback ? { fallbacks: [{ portalId: d.dtoB.id, channelId: CHANNEL_ON_B }] } : {}),
  });

const segmentsOf = async (d: Dual, pb: PlaybackDto): Promise<MediaSegment[]> =>
  (await readPlaylist(d.srv.admin, pb.streamUrl)).playlist.segments;

/** Attend qu'un segment de numéro > `after` apparaisse ; renvoie les segments nouveaux. */
async function newSegmentsAfter(
  d: Dual,
  pb: PlaybackDto,
  after: number,
  timeoutMs: number,
): Promise<MediaSegment[]> {
  return waitFor(
    `segment après ${after}`,
    async () => {
      const fresh = (await segmentsOf(d, pb)).filter((s) => s.seq > after);
      return fresh.length > 0 ? fresh : undefined;
    },
    timeoutMs,
    50,
  );
}

const lastSeq = (segments: MediaSegment[]): number => segments.at(-1)?.seq ?? -1;

function expectContiguous(segments: MediaSegment[]): void {
  segments.forEach((s, i) => {
    if (i > 0) expect(s.seq).toBe(segments[i - 1]!.seq + 1);
  });
}

describe('relais : lecture de base', () => {
  it('flux TS : playlist stable, segments de ~2 s décodables seuls, rien de l amont exposé', async () => {
    const d = await dual();
    const t0 = Date.now();
    const pb = await play(d, false);
    const startupMs = Date.now() - t0;
    console.log(`démarrage (POST /api/playback → premier segment prêt) : ${startupMs} ms`);
    expect(pb.format).toBe('hls');
    expect(pb.streamUrl).toBe(`/api/playback/${pb.sessionId}/index.m3u8`);
    // Démarrage < 2 s au 95e centile (PROJECT.md) : un seul tirage ici, donc marge réseau locale.
    expect(startupMs).toBeLessThan(2000);

    const segments = await waitFor(
      '3 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 3 ? s : undefined;
      },
      15_000,
    );
    const { text, playlist } = await readPlaylist(d.srv.admin, pb.streamUrl);
    expect(playlist.targetDurationS).toBe(6);
    expect(text).not.toMatch(/play_token|live\.php|127\.0\.0\.1|http:/);
    expectContiguous(segments);
    for (const s of segments.slice(1)) expect(s.durationS).toBeCloseTo(2, 1);
    expect(segments.some((s) => s.discontinuity)).toBe(false);
    for (const s of segments) {
      const bytes = await fetchSegment(d.srv.admin, s.uri);
      expect(bytes.length % 188).toBe(0);
      expect(await decodeErrors(bytes)).toBe('');
    }
  });

  it('flux HLS amont : réassemblé dans la playlist du relais, segments décodables', async () => {
    const d = await dual({}, 'm3u8');
    const pb = await play(d, false);
    const segments = await waitFor(
      '3 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 3 ? s : undefined;
      },
      15_000,
    );
    expectContiguous(segments);
    for (const s of segments.slice(-2)) {
      expect(await decodeErrors(await fetchSegment(d.srv.admin, s.uri))).toBe('');
    }
  });

  it('chaîne déjà relayée : un second spectateur démarre avec tout le tampon disponible', async () => {
    const d = await dual();
    const first = await play(d, false);
    await waitFor(
      '4 segments',
      async () => ((await segmentsOf(d, first)).length >= 4 ? true : undefined),
      15_000,
    );
    const t0 = Date.now();
    const second = await play(d, false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await segmentsOf(d, second)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('relais : pannes amont', () => {
  it('source A coupée : bascule sur B en moins de 2 s, même URL, numérotation continue, jonction marquée', async () => {
    const d = await dual();
    const pb = await play(d, true);
    const before = await waitFor(
      '2 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 2 ? s : undefined;
      },
      15_000,
    );
    const t0 = Date.now();
    await sendChaos(d.a.baseUrl, 'drop', { durationMs: 60_000, channelId: CHANNEL });
    const fresh = await newSegmentsAfter(d, pb, lastSeq(before), 10_000);
    const switchMs = Date.now() - t0;
    console.log(`bascule A → B (coupure → premier segment de B publié) : ${switchMs} ms`);

    const all = await segmentsOf(d, pb);
    expectContiguous(all);
    const junction = all.findIndex((s) => s.discontinuity);
    expect(junction).toBeGreaterThan(0);
    expect(all.filter((s) => s.discontinuity)).toHaveLength(1);
    expect(fresh.some((s) => s.discontinuity)).toBe(true);
    expect(await decodeErrors(await fetchSegment(d.srv.admin, all[junction]!.uri))).toBe('');
    expect(switchMs).toBeLessThan(MAX_SWITCH_MS);
    expect(await activeStreams(d.b, CHANNEL_ON_B)).toBe(1);
  });

  it('coupure courte sans alternative : playlist servie pendant la panne, reprise rapide avec jonction', async () => {
    const d = await dual();
    const pb = await play(d, false);
    const before = await waitFor(
      '2 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 2 ? s : undefined;
      },
      15_000,
    );
    const outageMs = 4000;
    await sendChaos(d.a.baseUrl, 'drop', { durationMs: outageMs, channelId: CHANNEL });
    const outageEnd = Date.now() + outageMs;
    await delay(1500);
    // Pendant la panne : la playlist répond toujours, le lecteur vide son tampon sans erreur.
    const during = await segmentsOf(d, pb);
    expect(during.length).toBeGreaterThanOrEqual(2);
    const fresh = await newSegmentsAfter(d, pb, lastSeq(during), 15_000);
    const resumeMs = Date.now() - outageEnd;
    console.log(`reprise après la fin de la coupure : ${resumeMs} ms`);
    expect(fresh[0]!.discontinuity).toBe(true);
    expect(fresh[0]!.seq).toBeGreaterThan(lastSeq(before));
    expectContiguous(await segmentsOf(d, pb));
    // Tant que les spectateurs ont du tampon, les tentatives restent espacées d'au plus 2 s.
    expect(resumeMs).toBeLessThan(3500);
  });

  it('token expiré en pleine lecture : renouvelé de façon transparente', async () => {
    const d = await dual();
    const pb = await play(d, false);
    const before = await waitFor(
      '2 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 2 ? s : undefined;
      },
      15_000,
    );
    const t0 = Date.now();
    await sendChaos(d.a.baseUrl, 'expire-token', { killStreams: true });
    await newSegmentsAfter(d, pb, lastSeq(before), 10_000);
    console.log(`reprise après expiration du token : ${Date.now() - t0} ms`);
    expect(Date.now() - t0).toBeLessThan(MAX_SWITCH_MS + 2000);
    expectContiguous(await segmentsOf(d, pb));
  });

  it('HTTP 403 soudain sur A : nouveau lien tenté puis bascule sur B en moins de 2 s', async () => {
    const d = await dual();
    const pb = await play(d, true);
    const before = await waitFor(
      '2 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 2 ? s : undefined;
      },
      15_000,
    );
    await sendChaos(d.a.baseUrl, 'http-error', { code: 403, probability: 1, scope: 'stream' });
    const t0 = Date.now();
    // Coupure d'une milliseconde : ferme le flux en cours, la reconnexion tombe sur le 403.
    await sendChaos(d.a.baseUrl, 'drop', { durationMs: 1, channelId: CHANNEL });
    const fresh = await newSegmentsAfter(d, pb, lastSeq(before), 10_000);
    const switchMs = Date.now() - t0;
    console.log(`403 → bascule : ${switchMs} ms`);
    expect(fresh.some((s) => s.discontinuity)).toBe(true);
    expect(switchMs).toBeLessThan(MAX_SWITCH_MS);
    expect(await activeStreams(d.b, CHANNEL_ON_B)).toBe(1);
  });

  it('aucune source joignable au démarrage : erreur claire, pas d attente interminable', async () => {
    const d = await dual();
    await sendChaos(d.a.baseUrl, 'drop', { durationMs: 60_000, channelId: CHANNEL });
    const t0 = Date.now();
    const res = await d.srv.admin.post('/api/playback', { portalId: d.dtoA.id, channelId: CHANNEL });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: { code: 'stream_unavailable' } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.text).not.toMatch(/127\.0\.0\.1|play_token/);
  });
});

describe('relais : partage et libération de la connexion amont', () => {
  it('50 spectateurs sur une chaîne : une seule connexion amont', async () => {
    const d = await dual({ maxStreamsPerUser: 60, maxStreamsTotal: 60, apiRequestsPerMinute: 100_000 });
    const sessions = await Promise.all(Array.from({ length: 50 }, () => play(d, false)));
    await Promise.all(sessions.map((pb) => segmentsOf(d, pb)));
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(50);
    expect(await activeStreams(d.a, CHANNEL)).toBe(1);
  });

  it('dernier spectateur parti : connexion amont fermée après le délai de grâce', async () => {
    const d = await dual({ relayLingerMs: 300 });
    const pb = await play(d, false);
    await segmentsOf(d, pb);
    expect(await activeStreams(d.a, CHANNEL)).toBe(1);
    expect((await d.srv.admin.delete(`/api/playback/${pb.sessionId}`)).status).toBe(204);
    await waitFor(
      'fermeture amont',
      async () => ((await activeStreams(d.a, CHANNEL)) === 0 ? true : undefined),
      3000,
    );
  });

  it('zapping sur le même portail : la chaîne quittée libère sa connexion tout de suite', async () => {
    // Délai de grâce long : seule l'ouverture d'une autre chaîne peut expliquer la fermeture.
    const d = await dual({ relayLingerMs: 60_000 });
    const first = await play(d, false, '1');
    await d.srv.admin.delete(`/api/playback/${first.sessionId}`);
    expect(await activeStreams(d.a, '1')).toBe(1);
    await play(d, false, '2');
    await waitFor(
      'chaîne 1 libérée',
      async () => ((await activeStreams(d.a, '1')) === 0 ? true : undefined),
      3000,
    );
    expect(await activeStreams(d.a, '2')).toBe(1);
  });
});

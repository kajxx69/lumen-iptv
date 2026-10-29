import type {
  ChannelHealthDto,
  ChannelListDto,
  PlaybackDto,
  PlaybackStatusDto,
  PortalDto,
} from '@lumen/protocol';
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

/**
 * Attend le premier segment de la nouvelle source (marqué DISCONTINUITY) au-delà de `after`.
 * Les segments courts du démarrage rapide de A peuvent encore arriver avant : ce ne sont
 * pas eux qu'on mesure.
 */
async function junctionAfter(
  d: Dual,
  pb: PlaybackDto,
  after: number,
  timeoutMs: number,
): Promise<MediaSegment[]> {
  return waitFor(
    `jonction après ${after}`,
    async () => {
      const fresh = (await segmentsOf(d, pb)).filter((s) => s.seq > after);
      return fresh.some((s) => s.discontinuity) ? fresh : undefined;
    },
    timeoutMs,
    50,
  );
}

const lastSeq = (segments: MediaSegment[]): number => segments.at(-1)?.seq ?? -1;

/** Le flux tel qu'un lecteur l'enchaîne : chaque segment à la suite du précédent. */
async function decodeChain(d: Dual, segments: MediaSegment[]): Promise<string> {
  const parts = [];
  for (const s of segments) parts.push(await fetchSegment(d.srv.admin, s.uri));
  return decodeErrors(Buffer.concat(parts));
}

/** Démarrage rapide (RELAY_FAST_START_S, segments de RELAY_FIRST_SEGMENT_TARGET_S) : tolérance d'une image. */
const FAST_START_SEGMENT_MAX_S = 0.6;

function expectContiguous(segments: MediaSegment[]): void {
  segments.forEach((s, i) => {
    if (i > 0) expect(s.seq).toBe(segments[i - 1]!.seq + 1);
  });
}

describe('relais : lecture de base', () => {
  it('flux TS : démarrage rapide puis segments de ~2 s, flux décodable, rien de l amont exposé', async () => {
    const d = await dual();
    const t0 = Date.now();
    const pb = await play(d, false);
    const startupMs = Date.now() - t0;
    console.log(`démarrage (POST /api/playback → premier segment prêt) : ${startupMs} ms`);
    expect(pb.format).toBe('hls');
    expect(pb.streamUrl).toBe(`/api/playback/${pb.sessionId}/index.m3u8`);
    // Démarrage < 2 s au 95e centile (PROJECT.md) : un seul tirage ici, donc marge réseau locale.
    expect(startupMs).toBeLessThan(2000);

    // Démarrage rapide (2 s de segments courts), puis au moins deux segments de croisière.
    const segments = await waitFor(
      '6 segments',
      async () => {
        const s = await segmentsOf(d, pb);
        return s.length >= 6 ? s : undefined;
      },
      20_000,
    );
    const { text, playlist } = await readPlaylist(d.srv.admin, pb.streamUrl);
    expect(playlist.targetDurationS).toBe(6);
    expect(text).not.toMatch(/play_token|live\.php|127\.0\.0\.1|http:/);
    expectContiguous(segments);
    // Le premier segment arrive vite : la lecture démarre sans attendre un GOP entier.
    expect(segments[0]!.durationS).toBeLessThanOrEqual(FAST_START_SEGMENT_MAX_S);
    for (const s of segments.slice(-2)) expect(s.durationS).toBeCloseTo(2, 1);
    expect(segments.some((s) => s.discontinuity)).toBe(false);
    for (const s of segments) {
      expect((await fetchSegment(d.srv.admin, s.uri)).length % 188).toBe(0);
    }
    // Le premier segment se décode seul ; l'ensemble se décode enchaîné, sans erreur.
    expect(await decodeErrors(await fetchSegment(d.srv.admin, segments[0]!.uri))).toBe('');
    expect(await decodeChain(d, segments)).toBe('');
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
    expect(await decodeChain(d, segments)).toBe('');
  });

  it('rechargement bloquant : le segment suivant est livré dès sa publication', async () => {
    const d = await dual();
    const pb = await play(d, false);
    const { text, playlist } = await readPlaylist(d.srv.admin, pb.streamUrl);
    expect(text).toContain('#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES');
    const next = lastSeq(playlist.segments) + 1;
    const t0 = Date.now();
    const blocked = await readPlaylist(d.srv.admin, `${pb.streamUrl}?_HLS_msn=${next}`);
    const waitedMs = Date.now() - t0;
    console.log(`rechargement bloquant : réponse après ${waitedMs} ms`);
    expect(lastSeq(blocked.playlist.segments)).toBeGreaterThanOrEqual(next);
    // Un segment dure ~2 s : la réponse attend sa publication, pas l'échéance de 8 s.
    expect(waitedMs).toBeLessThan(4000);
    // Demande absurde, trop loin dans le futur : refusée.
    expect((await d.srv.admin.get(`${pb.streamUrl}?_HLS_msn=${next + 50}`)).status).toBe(400);
  });

  it('direct au plus près (LL-HLS) : parties annoncées, livrées dès leur parution', async () => {
    const d = await dual();
    const pb = await startPlayback(d.srv.admin, {
      portalId: d.dtoA.id,
      channelId: CHANNEL,
      lowLatency: true,
    });
    // Laisser paraître quelques segments complets et leurs parties.
    await waitFor(
      '3 segments',
      async () => ((await segmentsOf(d, pb)).length >= 3 ? true : undefined),
      15_000,
    );
    const { text } = await readPlaylist(d.srv.admin, pb.streamUrl);
    expect(text).toContain('#EXT-X-PART-INF:PART-TARGET=0.500');
    expect(text).toMatch(/#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1\.500/);
    const parts = [...text.matchAll(/#EXT-X-PART:DURATION=([\d.]+),URI="([^"]+)"/g)];
    expect(parts.length).toBeGreaterThan(3);
    for (const [, duration] of parts) expect(Number(duration)).toBeLessThanOrEqual(0.5);
    const hint = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg\/(\d+)\.(\d+)\.ts"/.exec(text);
    expect(hint).not.toBeNull();
    const [, seq = '', part = ''] = hint ?? [];

    // La partie annoncée n'existe pas encore : sa requête attend sa parution (≤ une partie).
    const t0 = Date.now();
    const bytes = await fetchSegment(
      d.srv.admin,
      `${d.srv.baseUrl}/api/playback/${pb.sessionId}/seg/${seq}.${part}.ts`,
    );
    const hintMs = Date.now() - t0;
    console.log(`partie en préchargement servie après ${hintMs} ms`);
    expect(bytes.length % 188).toBe(0);
    expect(hintMs).toBeLessThan(1500);

    // Rechargement bloquant sur la partie suivante : réponse à sa parution.
    const t1 = Date.now();
    const next = await d.srv.admin.get(`${pb.streamUrl}?_HLS_msn=${seq}&_HLS_part=${Number(part) + 1}`);
    const blockedMs = Date.now() - t1;
    console.log(`rechargement bloquant par partie : ${blockedMs} ms`);
    expect(next.status).toBe(200);
    expect(blockedMs).toBeLessThan(1500);

    // Une session confort sur le même relais ne voit aucune partie.
    const comfort = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: CHANNEL });
    expect((await readPlaylist(d.srv.admin, comfort.streamUrl)).text).not.toContain('EXT-X-PART');
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
    const fresh = await junctionAfter(d, pb, lastSeq(before), 10_000);
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
    await junctionAfter(d, pb, lastSeq(before), 10_000);
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
    const fresh = await junctionAfter(d, pb, lastSeq(before), 10_000);
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

describe('moteur de résilience : sources trouvées seules, gel, écran noir, débit', () => {
  /** Une chaîne de A présente aussi sur B (même identifiant EPG), catalogue de B connu. */
  async function paired(d: Dual, index = 0): Promise<{ onA: string; onB: string }> {
    const list = await d.srv.admin.get<{
      channels: { id: string; epgId: string | null; censored: boolean }[];
    }>(`/api/portals/${d.dtoA.id}/channels`);
    const onA = list.body.channels.filter((c) => c.epgId !== null && !c.censored)[index]?.id;
    if (onA === undefined) throw new Error('aucune chaîne commune');
    await d.srv.admin.get(`/api/portals/${d.dtoB.id}/channels`);
    return { onA, onB: String(100_000 + Number(onA)) };
  }

  const status = async (d: Dual, pb: PlaybackDto): Promise<PlaybackStatusDto> =>
    (await d.srv.admin.get<PlaybackStatusDto>(`/api/playback/${pb.sessionId}/status`)).body;

  async function timeToSource(
    d: Dual,
    pb: PlaybackDto,
    portalId: string,
    t0: number,
    timeoutMs: number,
  ): Promise<number> {
    return waitFor(
      `bascule vers ${portalId}`,
      async () => {
        const s = await status(d, pb);
        return s.activePortalId === portalId && s.state === 'live' ? Date.now() - t0 : undefined;
      },
      timeoutMs,
      50,
    );
  }

  it('source de secours trouvée sans le client, par identifiant EPG', async () => {
    const d = await dual();
    const { onA } = await paired(d);
    const pb = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: onA });
    expect(await status(d, pb)).toMatchObject({ sourceCount: 2, activePortalId: d.dtoA.id });
  });

  it('gel des horodatages : détecté en moins de 2,5 s, bascule sur B', async () => {
    const d = await dual();
    const { onA } = await paired(d, 1);
    const pb = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: onA });
    await delay(3000);
    const t0 = Date.now();
    await sendChaos(d.a.baseUrl, 'freeze', { durationMs: 8000, channelId: onA });
    const ms = await timeToSource(d, pb, d.dtoB.id, t0, 10_000);
    console.log(`gel → premier segment de B : ${ms} ms`);
    expect(ms).toBeLessThan(2500 + MAX_SWITCH_MS);
  });

  it('écran noir et silence de 15 s : bascule sur B, A déclassée', async () => {
    const d = await dual();
    const { onA } = await paired(d, 2);
    const pb = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: onA });
    await delay(3000);
    const t0 = Date.now();
    await sendChaos(d.a.baseUrl, 'blackscreen', { durationMs: 15_000, channelId: onA });
    const ms = await timeToSource(d, pb, d.dtoB.id, t0, 20_000);
    console.log(`écran noir → premier segment de B : ${ms} ms`);
    const health = await d.srv.admin.get<ChannelHealthDto>(
      `/api/portals/${d.dtoA.id}/channels/${onA}/health`,
    );
    const score = (portalId: string): number =>
      health.body.sources.find((s) => s.portalId === portalId)?.score ?? NaN;
    expect(score(d.dtoA.id)).toBeLessThan(score(d.dtoB.id));
    // Classement par santé : B passe désormais devant A.
    expect(health.body.sources[0]?.portalId).toBe(d.dtoB.id);
  });

  it('débit divisé par 5 sur A : source trop lente, bascule sur B', async () => {
    const d = await dual();
    const { onA } = await paired(d, 3);
    const pb = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: onA });
    await delay(4000);
    const t0 = Date.now();
    await sendChaos(d.a.baseUrl, 'throttle', { bitrateKbps: 260 });
    const ms = await timeToSource(d, pb, d.dtoB.id, t0, 15_000);
    console.log(`débit /5 → premier segment de B : ${ms} ms`);
    expect(ms).toBeLessThan(8000);
  });

  it('premier octet lent à venir (3 s) puis débit normal : pas de fausse lenteur, A gardée', async () => {
    // Relevé sur un vrai portail : session, create_link et premier octet prennent plusieurs
    // secondes. Les quitter pour « lenteur » coûte cher (une seule connexion par abonnement).
    const d = await dual();
    const { onA } = await paired(d, 5);
    await sendChaos(d.a.baseUrl, 'latency', { ms: 3000, scope: 'stream' });
    // Pas de rafale d'ouverture (que le faux portail enverrait d'un bloc) : le flux arrive au
    // rythme du direct, comme sur ce portail. ≈ 1,25 fois son débit : la source tient le direct.
    await sendChaos(d.a.baseUrl, 'throttle', { bitrateKbps: 1800 });
    const pb = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: onA });
    const seen = new Set<string | null>();
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      seen.add((await status(d, pb)).activePortalId);
      await delay(200);
    }
    expect([...seen]).toEqual([d.dtoA.id]);
  });

  it('chaîne fusionnée (« Tous les portails ») : lue, et partagée avec la vue du portail', async () => {
    const d = await dual();
    const { onA, onB } = await paired(d, 4);
    const all = await d.srv.admin.get<ChannelListDto>('/api/portals/all/channels');
    const merged = all.body.channels.find((c) =>
      c.sources?.some((s) => s.portalId === d.dtoA.id && s.channelId === onA),
    );
    expect(merged?.sources?.map((s) => s.channelId)).toEqual([onA, onB]);
    const viaAll = await startPlayback(d.srv.admin, { portalId: 'all', channelId: merged?.id ?? '' });
    await waitFor(
      'lecture fusionnée',
      async () => ((await status(d, viaAll)).state === 'live' ? true : undefined),
      10_000,
    );
    // La même chaîne ouverte depuis la vue du portail A : même relais, aucune connexion de plus.
    const viaA = await startPlayback(d.srv.admin, { portalId: d.dtoA.id, channelId: onA });
    expect((await status(d, viaA)).state).toBe('live');
    const upstream = (await activeStreams(d.a, onA)) + (await activeStreams(d.b, onB));
    expect(upstream).toBe(1);
  });
});

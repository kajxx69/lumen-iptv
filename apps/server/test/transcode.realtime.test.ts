import type { PlaybackDto, PlaybackStatusDto, PortalDto } from '@lumen/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfigInput } from '../src/config.js';
import {
  type RunningPortal,
  type TestServer,
  activeStreams,
  addPortal,
  decodeErrors,
  fetchSegment,
  probeCodecs,
  probeHeight,
  readPlaylist,
  sendChaos,
  startPlayback,
  startPortal,
  startServer,
  waitFor,
} from './helpers.js';

/**
 * Transcodage en conditions réelles (PROJECT.md §8) : de vrais flux MPEG-2, HEVC et AC-3
 * servis par le portail factice, convertis par FFmpeg (libx264 : la machine de test n'a pas
 * d'encodeur matériel) et vérifiés par ffprobe.
 */

const CHANNEL = '1';
const CHANNEL_ON_B = '100001';
/** Démarrage d'une chaîne convertie : FFmpeg en plus du relais, sur une machine modeste. */
const TRANSCODED_START_MAX_MS = 8000;
const NO_CAPS = { hevc: false, ac3: false, eac3: false };

let opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const o of opened.reverse()) await o.close().catch(() => undefined);
  opened = [];
});

async function stack(
  media: { videoCodec?: 'h264' | 'hevc' | 'mpeg2'; audioCodec?: 'aac' | 'ac3' },
  server: Partial<ServerConfigInput> = {},
): Promise<{ portal: RunningPortal; srv: TestServer; dto: PortalDto }> {
  const portal = await startPortal({ channelCount: 20, media });
  const srv = await startServer(server);
  opened.push(portal, srv);
  return { portal, srv, dto: await addPortal(srv.admin, portal) };
}

const status = async (srv: TestServer, pb: PlaybackDto): Promise<PlaybackStatusDto> =>
  (await srv.admin.get<PlaybackStatusDto>(`/api/playback/${pb.sessionId}/status`)).body;

/**
 * Le flux de la session depuis son premier segment, enchaîné comme le lit un lecteur : les
 * segments du démarrage rapide ne commencent pas tous par une image clé.
 */
async function sessionStream(srv: TestServer, pb: PlaybackDto): Promise<Buffer> {
  const segments = await waitFor(
    '4 segments',
    async () => {
      const s = (await readPlaylist(srv.admin, pb.streamUrl)).playlist.segments;
      return s.length >= 4 ? s : undefined;
    },
    20_000,
  );
  const parts: Buffer[] = [];
  for (const s of segments) parts.push(await fetchSegment(srv.admin, s.uri));
  return Buffer.concat(parts);
}

describe('transcodage : seulement ce que le navigateur ne lit pas', () => {
  it('MPEG-2 + AC-3 → H.264 + AAC, décodable, démarrage mesuré', async () => {
    const { srv, dto } = await stack({ videoCodec: 'mpeg2', audioCodec: 'ac3' });
    const t0 = Date.now();
    const pb = await startPlayback(srv.admin, { portalId: dto.id, channelId: CHANNEL, caps: NO_CAPS });
    const startMs = Date.now() - t0;
    console.log(`démarrage d'une chaîne MPEG-2 + AC-3 convertie : ${startMs} ms`);
    expect(startMs).toBeLessThan(TRANSCODED_START_MAX_MS);
    expect((await status(srv, pb)).transcode).toEqual({ video: 'h264', audio: 'aac', hardware: false });
    const data = await sessionStream(srv, pb);
    expect(await probeCodecs(data)).toEqual({ video: 'h264', audio: 'aac' });
    expect(await decodeErrors(data)).toBe('');
  });

  it('H.264 + AC-3 : seul l audio est converti ; un navigateur qui lit l AC-3 reçoit le flux tel quel', async () => {
    const { portal, srv, dto } = await stack({ audioCodec: 'ac3' });
    const converted = await startPlayback(srv.admin, { portalId: dto.id, channelId: CHANNEL, caps: NO_CAPS });
    expect((await status(srv, converted)).transcode).toMatchObject({ video: 'copy', audio: 'aac' });
    expect(await probeCodecs(await sessionStream(srv, converted))).toEqual({ video: 'h264', audio: 'aac' });

    const native = await startPlayback(srv.admin, {
      portalId: dto.id,
      channelId: CHANNEL,
      caps: { ...NO_CAPS, ac3: true },
    });
    expect((await status(srv, native)).transcode).toBeNull();
    expect(await probeCodecs(await sessionStream(srv, native))).toEqual({ video: 'h264', audio: 'ac3' });
    // Deux sorties, une seule connexion amont.
    expect(await activeStreams(portal, CHANNEL)).toBe(1);
  });

  it('HEVC : copié pour un navigateur qui le décode, converti sinon', async () => {
    const { srv, dto } = await stack({ videoCodec: 'hevc' });
    const native = await startPlayback(srv.admin, {
      portalId: dto.id,
      channelId: CHANNEL,
      caps: { ...NO_CAPS, hevc: true },
    });
    expect((await status(srv, native)).transcode).toBeNull();
    const converted = await startPlayback(srv.admin, { portalId: dto.id, channelId: CHANNEL, caps: NO_CAPS });
    expect((await status(srv, converted)).transcode).toMatchObject({ video: 'h264', audio: 'copy' });
    expect((await probeCodecs(await sessionStream(srv, converted))).video).toBe('h264');
  });

  it('conversions vidéo plafonnées : au-delà, refus clair ; une conversion partagée ne compte qu une fois', async () => {
    const { srv, dto } = await stack({ videoCodec: 'mpeg2' }, { transcodeMaxVideo: 1 });
    const first = await startPlayback(srv.admin, { portalId: dto.id, channelId: CHANNEL, caps: NO_CAPS });
    // Même chaîne, même besoin : la conversion existante est partagée.
    const shared = await startPlayback(srv.admin, { portalId: dto.id, channelId: CHANNEL, caps: NO_CAPS });
    expect((await status(srv, shared)).transcode).not.toBeNull();
    const other = await srv.admin.post('/api/playback', { portalId: dto.id, channelId: '2', caps: NO_CAPS });
    expect(other.status).toBe(503);
    expect(other.body).toMatchObject({ error: { code: 'transcode_busy' } });
    // Les spectateurs partis, la place se libère.
    await srv.admin.delete(`/api/playback/${first.sessionId}`);
    await srv.admin.delete(`/api/playback/${shared.sessionId}`);
    const again = await srv.admin.post('/api/playback', { portalId: dto.id, channelId: '2', caps: NO_CAPS });
    expect(again.status).toBe(201);
  });

  it('bascule vers une source d un autre format : la conversion suit, le flux tel quel se convertit sans coupure', async () => {
    const a = await startPortal({ channelCount: 20, media: { audioCodec: 'ac3' } });
    const b = await startPortal({
      channelCount: 20,
      seed: 2,
      portalName: 'B',
      media: { videoCodec: 'mpeg2', audioCodec: 'ac3' },
    });
    const srv = await startServer();
    opened.push(a, b, srv);
    const dtoA = await addPortal(srv.admin, a, { name: 'A' });
    const dtoB = await addPortal(srv.admin, b, { name: 'B', mac: '00:1A:79:AB:CD:EE' });
    const fallbacks = [{ portalId: dtoB.id, channelId: CHANNEL_ON_B }];
    // Navigateur sans AC-3 : seul le son est converti sur A (H.264 + AC-3).
    const converted = await startPlayback(srv.admin, {
      portalId: dtoA.id,
      channelId: CHANNEL,
      caps: NO_CAPS,
      fallbacks,
    });
    expect((await status(srv, converted)).transcode).toMatchObject({ video: 'copy', audio: 'aac' });
    // Navigateur qui lit l'AC-3 : A lui est servie telle quelle.
    const native = await startPlayback(srv.admin, {
      portalId: dtoA.id,
      channelId: CHANNEL,
      caps: { ...NO_CAPS, ac3: true },
      fallbacks,
    });
    expect((await status(srv, native)).transcode).toBeNull();
    await sessionStream(srv, converted);
    await sessionStream(srv, native);

    await sendChaos(a.baseUrl, 'drop', { durationMs: 60_000, channelId: CHANNEL });
    // B diffuse en MPEG-2 : la sortie convertie passe à la vidéo transcodée…
    await waitFor(
      'conversion vidéo sur B',
      async () => ((await status(srv, converted)).transcode?.video === 'h264' ? true : undefined),
      30_000,
    );
    const fresh = await waitFor(
      'segments convertis de B',
      async () => {
        const s = (await readPlaylist(srv.admin, converted.streamUrl)).playlist.segments;
        const junction = s.findIndex((x) => x.discontinuity);
        return junction >= 0 && s.length - junction >= 2 ? s.slice(junction) : undefined;
      },
      30_000,
    );
    const after = Buffer.concat(
      await Promise.all(fresh.slice(0, 2).map((s) => fetchSegment(srv.admin, s.uri))),
    );
    expect(await probeCodecs(after)).toEqual({ video: 'h264', audio: 'aac' });
    // … et le spectateur servi tel quel passe de lui-même sur une sortie convertie, dans la
    // même playlist (numérotation continue, jonction marquée) : aucune session à rouvrir.
    await waitFor(
      'conversion du spectateur natif',
      async () => {
        await readPlaylist(srv.admin, native.streamUrl);
        return (await status(srv, native)).transcode?.video === 'h264' ? true : undefined;
      },
      30_000,
    );
    const nativeAfter = await waitFor(
      'segments convertis pour le spectateur natif',
      async () => {
        const s = (await readPlaylist(srv.admin, native.streamUrl)).playlist.segments;
        const last = s.at(-1);
        return last !== undefined &&
          (await probeCodecs(await fetchSegment(srv.admin, last.uri))).video === 'h264'
          ? s
          : undefined;
      },
      30_000,
    );
    nativeAfter.forEach((seg, i) => {
      if (i > 0) expect(seg.seq).toBe(nativeAfter[i - 1]!.seq + 1);
    });
  });

  it('changement de qualité en cours de lecture : même playlist, audio seul allégé, retour à la source', async () => {
    const { srv, dto } = await stack({});
    const pb = await startPlayback(srv.admin, { portalId: dto.id, channelId: CHANNEL, caps: NO_CAPS });
    const before = (await readPlaylist(srv.admin, pb.streamUrl)).playlist.segments;
    const sourceBytes =
      (await fetchSegment(srv.admin, before.at(-1)?.uri ?? '')).length / (before.at(-1)?.durationS ?? 1);

    const audio = await srv.admin.post<PlaybackStatusDto>(`/api/playback/${pb.sessionId}/quality`, {
      quality: 'audio',
    });
    expect(audio.status).toBe(200);
    expect(audio.body.quality).toEqual({ requested: 'audio', active: 'audio' });
    // La playlist continue : au prochain point de rendez-vous, l'image n'est plus qu'une vignette.
    const light = await waitFor(
      'segments audio seul',
      async () => {
        const s = (await readPlaylist(srv.admin, pb.streamUrl)).playlist.segments;
        const junction = s.findIndex((x, i) => i > 0 && x.discontinuity);
        return junction > 0 && s.length - junction >= 2 ? s.slice(junction) : undefined;
      },
      30_000,
    );
    const lightSeg = await fetchSegment(srv.admin, light[1]?.uri ?? '');
    expect(await probeHeight(lightSeg)).toBeLessThanOrEqual(144);
    const lightBytes = lightSeg.length / (light[1]?.durationS ?? 1);
    console.log(
      `débit source : ${Math.round((sourceBytes * 8) / 1000)} kbit/s, audio seul : ${Math.round((lightBytes * 8) / 1000)} kbit/s`,
    );
    expect(lightBytes).toBeLessThan(sourceBytes / 4);
    const all = (await readPlaylist(srv.admin, pb.streamUrl)).playlist.segments;
    all.forEach((seg, i) => {
      if (i > 0) expect(seg.seq).toBe(all[i - 1]!.seq + 1);
    });

    // Retour à la qualité source : la sortie directe, sans transcodage.
    const back = await srv.admin.post<PlaybackStatusDto>(`/api/playback/${pb.sessionId}/quality`, {
      quality: 'source',
    });
    expect(back.body.transcode).toBeNull();
    expect(back.body.quality.active).toBe('source');
  });

  it('qualité réduite impossible (conversions saturées) : la lecture démarre quand même, en qualité source', async () => {
    const { srv, dto } = await stack({}, { transcodeMaxVideo: 1 });
    const first = await startPlayback(srv.admin, {
      portalId: dto.id,
      channelId: CHANNEL,
      caps: NO_CAPS,
      quality: 'low',
    });
    expect((await status(srv, first)).quality.active).toBe('low');
    // Plus de place : la qualité réduite reste demandée, la source est servie en attendant.
    const second = await srv.admin.post<PlaybackDto>('/api/playback', {
      portalId: dto.id,
      channelId: '2',
      caps: NO_CAPS,
      quality: 'low',
    });
    expect(second.status).toBe(201);
    const s2 = await status(srv, second.body);
    expect(s2.quality).toEqual({ requested: 'low', active: 'source' });
    expect(s2.transcode).toBeNull();
  });

  it('bascule de source pendant une conversion : la conversion repart, jonction marquée', async () => {
    const a = await startPortal({ channelCount: 20, media: { videoCodec: 'mpeg2', audioCodec: 'ac3' } });
    const b = await startPortal({
      channelCount: 20,
      seed: 2,
      portalName: 'B',
      media: { videoCodec: 'mpeg2', audioCodec: 'ac3' },
    });
    const srv = await startServer();
    opened.push(a, b, srv);
    const dtoA = await addPortal(srv.admin, a, { name: 'A' });
    const dtoB = await addPortal(srv.admin, b, { name: 'B', mac: '00:1A:79:AB:CD:EE' });
    const pb = await startPlayback(srv.admin, {
      portalId: dtoA.id,
      channelId: CHANNEL,
      caps: NO_CAPS,
      fallbacks: [{ portalId: dtoB.id, channelId: CHANNEL_ON_B }],
    });
    await sessionStream(srv, pb);
    await sendChaos(a.baseUrl, 'drop', { durationMs: 60_000, channelId: CHANNEL });
    const fresh = await waitFor(
      'segments convertis de B',
      async () => {
        const s = (await readPlaylist(srv.admin, pb.streamUrl)).playlist.segments;
        const junction = s.findIndex((x) => x.discontinuity);
        return junction >= 0 && s.length - junction >= 2 ? s.slice(junction) : undefined;
      },
      30_000,
    );
    expect((await status(srv, pb)).activePortalId).toBe(dtoB.id);
    const after = Buffer.concat(
      await Promise.all(fresh.slice(0, 2).map((s) => fetchSegment(srv.admin, s.uri))),
    );
    expect(await probeCodecs(after)).toEqual({ video: 'h264', audio: 'aac' });
  });
});

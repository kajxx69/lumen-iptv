import {
  type EpisodeDto,
  type MovieListDto,
  type SeriesDetailDto,
  type SeriesListDto,
  VOD_TIMELINE_EPOCH_MS,
  type VodPlaybackDto,
  type VodPlayRequest,
} from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiClient,
  PORTAL_MAC,
  type Stack,
  delay,
  fetchSegment,
  probeCodecs,
  sendChaos,
  startStack,
  waitFor,
} from './helpers.js';

/** Un film du portail factice : la boucle de mire, une fois (64 s). */
const MOVIE_S = 64;
/** Marge sur les positions : une image clé par segment de 2 s dans le fichier factice. */
const KEYFRAME_TOLERANCE_S = 2.1;

interface VodPlaylist {
  pdt: number[];
  durations: number[];
  uris: string[];
  ended: boolean;
  discontinuities: number;
}

function parseVodPlaylist(text: string): VodPlaylist {
  const lines = text.split('\n');
  const out: VodPlaylist = { pdt: [], durations: [], uris: [], ended: false, discontinuities: 0 };
  for (const line of lines) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      out.pdt.push(
        (Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length)) - VOD_TIMELINE_EPOCH_MS) / 1000,
      );
    } else if (line.startsWith('#EXTINF:')) out.durations.push(Number.parseFloat(line.slice(8)));
    else if (line === '#EXT-X-ENDLIST') out.ended = true;
    else if (line === '#EXT-X-DISCONTINUITY') out.discontinuities++;
    else if (line !== '' && !line.startsWith('#')) out.uris.push(line);
  }
  return out;
}

async function play(client: ApiClient, request: VodPlayRequest): Promise<VodPlaybackDto> {
  const res = await client.post<VodPlaybackDto>('/api/vod/sessions', request);
  if (res.status !== 201) throw new Error(`lecture refusée : ${res.status} ${res.text}`);
  return res.body;
}

async function playlistOf(client: ApiClient, dto: VodPlaybackDto): Promise<VodPlaylist> {
  const res = await client.get(dto.playlistUrl);
  expect(res.status).toBe(200);
  return parseVodPlaylist(res.text);
}

/** Lit le film comme un lecteur : chaque segment dès qu'il paraît, jusqu'à la fin de la playlist. */
async function readToEnd(
  client: ApiClient,
  dto: VodPlaybackDto,
  timeoutMs: number,
): Promise<{ playlist: VodPlaylist; segments: Buffer[] }> {
  const base = `${client.baseUrl}${dto.playlistUrl.replace(/playlist\.m3u8$/, '')}`;
  const segments: Buffer[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const playlist = await playlistOf(client, dto);
    while (segments.length < playlist.uris.length) {
      segments.push(await fetchSegment(client, `${base}${playlist.uris[segments.length] ?? ''}`));
    }
    if (playlist.ended && segments.length === playlist.uris.length) return { playlist, segments };
    if (Date.now() > deadline) throw new Error('fin du film jamais atteinte');
    await delay(200);
  }
}

/** Les segments se suivent sans trou : chacun commence où finit le précédent. */
function expectContiguous(p: VodPlaylist): void {
  for (let i = 1; i < p.pdt.length; i++) {
    expect(Math.abs((p.pdt[i - 1] ?? 0) + (p.durations[i - 1] ?? 0) - (p.pdt[i] ?? 0))).toBeLessThan(0.15);
  }
}

describe('lecture de films (FFmpeg réel)', () => {
  let stack: Stack;
  let movieId: string;
  const movie = (): VodPlayRequest['item'] => ({ kind: 'movie', portalId: stack.portalDto.id, movieId });

  beforeAll(async () => {
    stack = await startStack(
      { channelCount: 10, vodCount: 5, seriesCount: 2 },
      // Avance réduite : la mise en pause de la production se voit sur un film de 64 s.
      { vodAheadS: 12, vodBehindS: 8, vodUpstreamRetryDeadlineMs: 15_000 },
    );
    const list = await waitFor(
      'catalogue de films',
      async () => {
        const res = await stack.srv.admin.get<MovieListDto>(`/api/portals/${stack.portalDto.id}/movies`);
        return res.body.complete ? res.body : undefined;
      },
      60_000,
      200,
    );
    movieId = list.items[0]?.id ?? '';
  }, 120_000);
  afterAll(async () => stack.close());

  it('depuis le début : durée, piste, position 0, flux copié, jusqu à la fin du film', async () => {
    const dto = await play(stack.srv.admin, { item: movie() });
    expect(dto.durationS).toBeGreaterThan(MOVIE_S - 1);
    expect(dto.durationS).toBeLessThan(MOVIE_S + 1);
    expect(dto.audioTracks).toHaveLength(1);
    expect(dto.transcode).toEqual({ video: false, audio: false });
    const { playlist, segments } = await readToEnd(stack.srv.admin, dto, 60_000);
    expect(playlist.pdt[0]).toBeLessThan(0.5);
    expectContiguous(playlist);
    const last = playlist.pdt.length - 1;
    expect((playlist.pdt[last] ?? 0) + (playlist.durations[last] ?? 0)).toBeGreaterThan(MOVIE_S - 1);
    expect(await probeCodecs(segments[2] ?? Buffer.alloc(0))).toEqual({ video: 'h264', audio: 'aac' });
    await stack.srv.admin.delete(`/api/vod/sessions/${dto.sessionId}`);
  }, 90_000);

  it('reprise à 40 s : la playlist porte la vraie position dans le film', async () => {
    const dto = await play(stack.srv.admin, { item: movie(), startS: 40 });
    expect(dto.startS).toBe(40);
    const playlist = await playlistOf(stack.srv.admin, dto);
    expect(playlist.pdt[0]).toBeGreaterThan(40 - KEYFRAME_TOLERANCE_S);
    expect(playlist.pdt[0]).toBeLessThan(40 + 0.5);
    await stack.srv.admin.delete(`/api/vod/sessions/${dto.sessionId}`);
  }, 60_000);

  it('lecteur en pause : la production s arrête à l avance fixée, puis repart à la demande', async () => {
    const dto = await play(stack.srv.admin, { item: movie() });
    await delay(3000);
    const paused = await playlistOf(stack.srv.admin, dto);
    const produced = paused.durations.reduce((a, b) => a + b, 0);
    // 12 s d'avance au plus, plus le segment en cours de découpe au moment de la pause.
    expect(produced).toBeLessThan(12 + 4 + 1);
    expect(paused.ended).toBe(false);
    const { playlist } = await readToEnd(stack.srv.admin, dto, 60_000);
    expect(playlist.ended).toBe(true);
    await stack.srv.admin.delete(`/api/vod/sessions/${dto.sessionId}`);
  }, 90_000);

  it('coupure du portail en plein film : reprise à l octet près, aucun trou dans le film', async () => {
    // Débit limité : le fichier reste en cours de téléchargement au moment de la coupure.
    await sendChaos(stack.portal.baseUrl, 'throttle', { bitrateKbps: 4000 });
    try {
      const dto = await play(stack.srv.admin, { item: movie() });
      await delay(1500);
      await sendChaos(stack.portal.baseUrl, 'drop', { durationMs: 3000 });
      const { playlist } = await readToEnd(stack.srv.admin, dto, 90_000);
      expectContiguous(playlist);
      expect(playlist.discontinuities).toBe(0);
      const last = playlist.pdt.length - 1;
      expect((playlist.pdt[last] ?? 0) + (playlist.durations[last] ?? 0)).toBeGreaterThan(MOVIE_S - 1);
      expect(stack.srv.logs.some((l) => l.includes('fichier du film interrompu : reprise'))).toBe(true);
      await stack.srv.admin.delete(`/api/vod/sessions/${dto.sessionId}`);
    } finally {
      await sendChaos(stack.portal.baseUrl, 'reset');
    }
  }, 120_000);

  it('épisode d une série : saisons, épisodes, lecture', async () => {
    const base = `/api/portals/${stack.portalDto.id}`;
    const series = await waitFor(
      'catalogue de séries',
      async () => {
        const res = await stack.srv.admin.get<SeriesListDto>(`${base}/series`);
        return res.body.complete ? res.body : undefined;
      },
      60_000,
      200,
    );
    const seriesId = series.items[0]?.id ?? '';
    const detail = (await stack.srv.admin.get<SeriesDetailDto>(`${base}/series/${seriesId}`)).body;
    const seasonId = detail.seasons[0]?.id ?? '';
    const episodes = (
      await stack.srv.admin.get<EpisodeDto[]>(`${base}/series/${seriesId}/seasons/${seasonId}`)
    ).body;
    const dto = await play(stack.srv.admin, {
      item: {
        kind: 'episode',
        portalId: stack.portalDto.id,
        seriesId,
        seasonId,
        episodeId: episodes[0]?.id ?? '',
      },
    });
    expect(dto.durationS).toBeGreaterThan(MOVIE_S - 1);
    expect((await playlistOf(stack.srv.admin, dto)).uris.length).toBeGreaterThan(0);
    await stack.srv.admin.delete(`/api/vod/sessions/${dto.sessionId}`);
  }, 90_000);

  it('saut : la lecture remplacée est fermée ; celle d un autre compte reste introuvable', async () => {
    const first = await play(stack.srv.admin, { item: movie() });
    const second = await play(stack.srv.admin, { item: movie(), startS: 30, replaces: first.sessionId });
    expect((await stack.srv.admin.get(first.playlistUrl)).status).toBe(404);
    await stack.srv.admin.post('/api/users', { username: 'voisin', password: 'voisin-password' });
    const other = stack.srv.client();
    await other.login('voisin', 'voisin-password');
    expect((await other.get(second.playlistUrl)).status).toBe(404);
    expect((await other.delete(`/api/vod/sessions/${second.sessionId}`)).status).toBe(204);
    expect((await stack.srv.admin.get(second.playlistUrl)).status).toBe(200);
    await stack.srv.admin.delete(`/api/vod/sessions/${second.sessionId}`);
  }, 60_000);

  it('film inconnu : 404 ; rien de secret dans les journaux', async () => {
    const res = await stack.srv.admin.post('/api/vod/sessions', {
      item: { kind: 'movie', portalId: stack.portalDto.id, movieId: '999999' },
    });
    expect(res.status).toBe(404);
    const logs = stack.srv.logs.join('\n');
    expect(logs).not.toContain('play_token');
    expect(logs).not.toContain(PORTAL_MAC);
    expect(logs).not.toContain('/play/movie.php');
  });
});

describe('lecture de films : conversion', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      channelCount: 10,
      vodCount: 3,
      seriesCount: 1,
      media: { videoCodec: 'mpeg2', audioCodec: 'ac3' },
    });
  }, 120_000);
  afterAll(async () => stack.close());

  it('MPEG-2 + AC-3 : converti en H.264 + AAC pour le navigateur, signalé', async () => {
    const list = await waitFor(
      'catalogue de films',
      async () => {
        const res = await stack.srv.admin.get<MovieListDto>(`/api/portals/${stack.portalDto.id}/movies`);
        return res.body.complete ? res.body : undefined;
      },
      60_000,
      200,
    );
    const dto = await play(stack.srv.admin, {
      item: { kind: 'movie', portalId: stack.portalDto.id, movieId: list.items[0]?.id ?? '' },
    });
    expect(dto.transcode).toEqual({ video: true, audio: true });
    const playlist = await playlistOf(stack.srv.admin, dto);
    const base = `${stack.srv.baseUrl}${dto.playlistUrl.replace(/playlist\.m3u8$/, '')}`;
    const segment = await fetchSegment(stack.srv.admin, `${base}${playlist.uris[0] ?? ''}`);
    expect(await probeCodecs(segment)).toEqual({ video: 'h264', audio: 'aac' });
    await stack.srv.admin.delete(`/api/vod/sessions/${dto.sessionId}`);
  }, 120_000);
});

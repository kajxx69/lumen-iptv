import {
  type ChannelListDto,
  type EpgEntryDto,
  VOD_TIMELINE_EPOCH_MS,
  type VodPlaybackDto,
} from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiClient, type Stack, delay, fetchSegment, probeCodecs, startStack } from './helpers.js';

const HOUR_MS = 3_600_000;
/** Une image clé par segment de 2 s dans les flux du portail factice. */
const KEYFRAME_TOLERANCE_S = 2.1;

interface Parsed {
  pdt: number[];
  durations: number[];
  uris: string[];
  ended: boolean;
}

function parse(text: string): Parsed {
  const out: Parsed = { pdt: [], durations: [], uris: [], ended: false };
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      out.pdt.push(
        (Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length)) - VOD_TIMELINE_EPOCH_MS) / 1000,
      );
    } else if (line.startsWith('#EXTINF:')) out.durations.push(Number.parseFloat(line.slice(8)));
    else if (line === '#EXT-X-ENDLIST') out.ended = true;
    else if (line !== '' && !line.startsWith('#')) out.uris.push(line);
  }
  return out;
}

async function playlist(client: ApiClient, dto: VodPlaybackDto): Promise<Parsed> {
  return parse((await client.get(dto.playlistUrl)).text);
}

describe('rattrapage : émissions lues dans l archive du portail', () => {
  let stack: Stack;
  let channelId: string;
  let noArchiveId: string;
  let past: EpgEntryDto;
  let current: EpgEntryDto;

  beforeAll(async () => {
    // Le test lit les segments plus vite qu'un lecteur : quota de requêtes relevé.
    stack = await startStack({ channelCount: 40 }, { apiRequestsPerMinute: 20_000 });
    const base = `/api/portals/${stack.portalDto.id}`;
    const list = (await stack.srv.admin.get<ChannelListDto>(`${base}/channels`)).body;
    const withArchive = list.channels.filter((c) => c.archiveHours > 0 && !c.censored);
    noArchiveId = list.channels.find((c) => c.archiveHours === 0)?.id ?? '';
    const now = Date.now();
    for (const c of withArchive) {
      const epg = (
        await stack.srv.admin.get<EpgEntryDto[]>(
          `${base}/channels/${c.id}/epg?from=${now - 3 * HOUR_MS}&to=${now + HOUR_MS}`,
        )
      ).body;
      const done = epg.find((e) => e.catchup && e.end <= now);
      const airing = epg.find((e) => e.catchup && e.start <= now && now < e.end);
      if (done !== undefined && airing !== undefined) {
        channelId = c.id;
        past = done;
        current = airing;
        break;
      }
    }
  }, 120_000);
  afterAll(async () => stack.close());

  const play = async (entry: EpgEntryDto, startS = 0, channel = channelId) => {
    return stack.srv.admin.post<VodPlaybackDto>('/api/vod/sessions', {
      item: {
        kind: 'archive',
        portalId: stack.portalDto.id,
        channelId: channel,
        start: entry.start,
        end: entry.end,
      },
      startS,
    });
  };

  it('émission passée : durée du guide, lecture depuis son début, image décodable', async () => {
    const res = await play(past);
    expect(res.status, res.text).toBe(201);
    expect(res.body.durationS).toBeCloseTo((past.end - past.start) / 1000, 0);
    const p = await playlist(stack.srv.admin, res.body);
    expect(p.pdt[0]).toBeLessThan(0.5);
    const base = `${stack.srv.baseUrl}${res.body.playlistUrl.replace(/playlist\.m3u8$/, '')}`;
    const segment = await fetchSegment(stack.srv.admin, `${base}${p.uris[1] ?? ''}`);
    expect(await probeCodecs(segment)).toEqual({ video: 'h264', audio: 'aac' });
    await stack.srv.admin.delete(`/api/vod/sessions/${res.body.sessionId}`);
  }, 90_000);

  it('saut dans une émission archivée : la lecture repart à la bonne position', async () => {
    const res = await play(past, 60);
    expect(res.status, res.text).toBe(201);
    const p = await playlist(stack.srv.admin, res.body);
    expect(p.pdt[0]).toBeGreaterThan(60 - KEYFRAME_TOLERANCE_S);
    expect(p.pdt[0]).toBeLessThan(60 + 0.5);
    await stack.srv.admin.delete(`/api/vod/sessions/${res.body.sessionId}`);
  }, 90_000);

  it('émission en cours, depuis son début : l archive s arrête au présent', async () => {
    const res = await play(current);
    expect(res.status, res.text).toBe(201);
    const base = `${stack.srv.baseUrl}${res.body.playlistUrl.replace(/playlist\.m3u8$/, '')}`;
    let p = await playlist(stack.srv.admin, res.body);
    let fetched = 0;
    const deadline = Date.now() + 120_000;
    while (!p.ended && Date.now() < deadline) {
      while (fetched < p.uris.length)
        await fetchSegment(stack.srv.admin, `${base}${p.uris[fetched++] ?? ''}`);
      await delay(200);
      p = await playlist(stack.srv.admin, res.body);
    }
    expect(p.ended).toBe(true);
    const last = p.pdt.length - 1;
    const reached = (p.pdt[last] ?? 0) + (p.durations[last] ?? 0);
    // Jusqu'au présent (à la demande), pas au-delà : on ne lit pas l'avenir.
    const playedUpTo = (Date.now() - current.start) / 1000;
    expect(reached).toBeLessThanOrEqual(playedUpTo + 1);
    expect(reached).toBeGreaterThan(playedUpTo - 120);
    await stack.srv.admin.delete(`/api/vod/sessions/${res.body.sessionId}`);
  }, 180_000);

  it('chaîne sans archive, ou émission inconnue : refus clair', async () => {
    const none = await play(past, 0, noArchiveId);
    expect(none.status).toBe(404);
    const unknown = await play({ ...past, start: past.start - 30 * HOUR_MS, end: past.end - 30 * HOUR_MS });
    expect(unknown.status).toBe(404);
  });
});

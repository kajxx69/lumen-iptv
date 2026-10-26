import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChaosWindow } from '../src/chaos/controller.js';
import { TIMESTAMP_MODULO, timestampDelta } from '../src/media/mpegts.js';
import {
  FRAME_TICKS,
  type RunningPortal,
  StalkerTestClient,
  TsCapture,
  chaos,
  delay,
  ffmpegAnalyze,
  startPortal,
} from './helpers.js';

interface ChaosResponse {
  result: ChaosWindow;
}

async function tempFile(name: string, content: Buffer): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), 'lumen-chaos-')), name);
  await writeFile(file, content);
  return file;
}

const sumMatches = (log: string, re: RegExp): number =>
  [...log.matchAll(re)].reduce((s, m) => s + Number(m[1]), 0);

/**
 * Pannes de contenu : la connexion reste saine, c'est le flux lui-même qui ment.
 * Ce sont les cas que les lecteurs classiques ne détectent pas.
 */
describe('API de chaos : pannes de contenu', () => {
  let portal: RunningPortal;
  let client: StalkerTestClient;

  beforeAll(async () => {
    portal = await startPortal({ apiRateLimitPerSecond: 10_000 });
  });
  afterAll(async () => portal.close());
  beforeEach(async () => {
    await chaos(portal.baseUrl, 'reset');
    client = new StalkerTestClient(portal.baseUrl);
    await client.handshake();
  });

  /** Ouvre la variante HLS d'une chaîne et renvoie l'URL d'un segment k. */
  async function hlsSegmentUrl(channelId: number): Promise<(k: number) => string> {
    const url = (await client.liveUrl(channelId)).replace('extension=ts', 'extension=m3u8');
    const playlist = await (await fetch(url)).text();
    const token = /play_token=([0-9A-F]+)/.exec(playlist)?.[1];
    if (token === undefined) throw new Error('playlist sans token');
    return (k) => `${portal.baseUrl}/hls/${channelId}/${k}.ts?play_token=${token}`;
  }

  const fetchSegment = async (url: string): Promise<Buffer> => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  };

  describe('freeze', () => {
    it('les octets continuent d arriver mais le PTS vidéo reste figé pendant la fenêtre', async () => {
      const FREEZE_MS = 4000;
      // Le contenu part par tranches de 200 ms, après avoir été « produit ».
      const PACING_SLACK_MS = 400;
      const capture = await TsCapture.open(await client.liveUrl(11));
      await delay(2000);

      const { result: window } = (await chaos(portal.baseUrl, 'freeze', {
        durationMs: FREEZE_MS,
        channelId: '11',
      })) as ChaosResponse;
      await delay(FREEZE_MS + 2500);
      // Le serveur n'a jamais coupé la connexion : un gel n'est pas une panne réseau.
      expect(capture.closedAt).toBeUndefined();
      capture.close();

      const frozenPts = portal.timeline.ptsAt(window.startMs) % TIMESTAMP_MODULO;
      const before = capture.video.filter((s) => s.at < window.startMs);
      const frozen = capture.video.filter((s) => s.pts === frozenPts);
      const after = capture.video.filter((s) => s.at > window.endMs + PACING_SLACK_MS);

      // Avant : progression normale, une image toutes les 40 ms.
      expect(before.length).toBeGreaterThan(25);
      for (let i = 1; i < before.length; i++)
        expect(timestampDelta(before[i - 1]!.pts, before[i]!.pts)).toBe(FRAME_TICKS);

      // Pendant : ~100 images portant toutes le même PTS, étalées sur toute la fenêtre.
      expect(frozen.length).toBeGreaterThanOrEqual(0.9 * (FREEZE_MS / 40));
      expect(frozen[0]!.at).toBeGreaterThanOrEqual(window.startMs);
      expect(frozen.at(-1)!.at - frozen[0]!.at).toBeGreaterThan(FREEZE_MS - 2 * PACING_SLACK_MS);
      expect(frozen.at(-1)!.at).toBeLessThanOrEqual(window.endMs + PACING_SLACK_MS);

      // Les octets n'ont jamais cessé d'arriver : la socket est active, le flux est figé.
      for (let t = window.startMs + PACING_SLACK_MS; t + 500 <= window.endMs; t += 500) {
        expect(capture.bytesBetween(t, t + 500)).toBeGreaterThan(0);
      }

      // Après : le PTS reprend, au niveau de l'horloge réelle (saut de la durée du gel).
      expect(after.length).toBeGreaterThan(25);
      for (let i = 1; i < after.length; i++)
        expect(timestampDelta(after[i - 1]!.pts, after[i]!.pts)).toBe(FRAME_TICKS);
      expect(timestampDelta(frozenPts, after[0]!.pts)).toBeGreaterThanOrEqual(FREEZE_MS * 90);
    });

    it('ne touche que la chaîne visée', async () => {
      const capture = await TsCapture.open(await client.liveUrl(12));
      await delay(500);
      const { result: window } = (await chaos(portal.baseUrl, 'freeze', {
        durationMs: 2000,
        channelId: '11',
      })) as ChaosResponse;
      await delay(2500);
      capture.close();
      const during = capture.video.filter((s) => s.at >= window.startMs && s.at < window.endMs);
      expect(new Set(during.map((s) => s.pts)).size).toBe(during.length);
    });
  });

  describe('blackscreen', () => {
    it('image noire et silence pendant la fenêtre, mire normale autour (vérifié par FFmpeg)', async () => {
      const BLACK_MS = 6000;
      const segmentUrl = await hlsSegmentUrl(21);
      const { result: window } = (await chaos(portal.baseUrl, 'blackscreen', {
        durationMs: BLACK_MS,
        channelId: '21',
      })) as ChaosResponse;

      const { timeline } = portal;
      const startK = timeline.segmentAt(window.startMs);
      const firstBlack = timeline.segmentStartMs(startK) < window.startMs ? startK + 1 : startK;
      const lastBlack = timeline.segmentAt(window.endMs - 1);
      expect(lastBlack - firstBlack + 1).toBeGreaterThanOrEqual(2);
      // Attendre que le segment témoin suivant soit publié.
      await delay(timeline.segmentStartMs(lastBlack + 2) - Date.now() + 200);

      const black: Buffer[] = [];
      for (let k = firstBlack; k <= lastBlack; k++) black.push(await fetchSegment(segmentUrl(k)));
      const controls = Buffer.concat([
        await fetchSegment(segmentUrl(firstBlack - 1)),
        await fetchSegment(segmentUrl(lastBlack + 1)),
      ]);

      const filters = ['-vf', 'blackdetect=d=0.5:pix_th=0.1', '-af', 'silencedetect=n=-50dB:d=0.5'];
      const blackLog = await ffmpegAnalyze(await tempFile('black.ts', Buffer.concat(black)), filters);
      const blackSeconds = ((lastBlack - firstBlack + 1) * timeline.segmentMs) / 1000;
      expect(sumMatches(blackLog, /black_duration:\s*([\d.]+)/g)).toBeGreaterThanOrEqual(blackSeconds - 0.2);
      expect(blackLog).toMatch(/silence_start/);

      const controlLog = await ffmpegAnalyze(await tempFile('control.ts', controls), filters);
      expect(controlLog).not.toMatch(/black_start/);
      expect(controlLog).not.toMatch(/silence_start/);
    });
  });

  describe('corrupt', () => {
    it('probabilité 1 : le segment servi est altéré et FFmpeg signale des erreurs de décodage', async () => {
      const segmentUrl = await hlsSegmentUrl(31);
      const k = portal.timeline.segmentAt(Date.now()) - 2;
      const clean = await fetchSegment(segmentUrl(k));

      await chaos(portal.baseUrl, 'corrupt', { segmentProbability: 1, seed: 3 });
      const corrupted = await fetchSegment(segmentUrl(k));
      expect(corrupted).toHaveLength(clean.length);
      expect(corrupted.equals(clean)).toBe(false);
      for (let off = 0; off < corrupted.length; off += 188) expect(corrupted[off]).toBe(0x47);

      const cleanLog = await ffmpegAnalyze(await tempFile('clean.ts', clean), ['-v', 'error']);
      const corruptLog = await ffmpegAnalyze(await tempFile('corrupt.ts', corrupted), ['-v', 'error']);
      expect(cleanLog.trim()).toBe('');
      expect(corruptLog.trim()).not.toBe('');

      await chaos(portal.baseUrl, 'reset');
      expect((await fetchSegment(segmentUrl(k))).equals(clean)).toBe(true);
    });

    it('probabilité 0,5 : une partie seulement des segments est touchée', async () => {
      const segmentUrl = await hlsSegmentUrl(32);
      const latest = portal.timeline.segmentAt(Date.now()) - 1;
      const ks = Array.from({ length: 16 }, (_, i) => latest - i);
      const clean = await Promise.all(ks.map((k) => fetchSegment(segmentUrl(k))));
      await chaos(portal.baseUrl, 'corrupt', { segmentProbability: 0.5, seed: 11 });
      const served = await Promise.all(ks.map((k) => fetchSegment(segmentUrl(k))));
      const touched = served.filter((buf, i) => !buf.equals(clean[i]!)).length;
      expect(touched).toBeGreaterThan(2);
      expect(touched).toBeLessThan(14);
    });
  });
});

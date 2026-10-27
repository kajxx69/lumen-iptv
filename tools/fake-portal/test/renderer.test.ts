import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChaosController } from '../src/chaos/controller.js';
import type { Clock } from '../src/clock.js';
import type { MediaAssets } from '../src/media/assets.js';
import {
  ContinuityRewriter,
  isAudioStream,
  isVideoStream,
  listPes,
  timestampDelta,
} from '../src/media/mpegts.js';
import { LiveTimeline, SegmentRenderer } from '../src/media/renderer.js';
import { FRAME_TICKS, ffmpegAnalyze, sharedAssets } from './helpers.js';

const EPOCH = 1_700_000_000_000;
const CORRUPT_RATIO = 0.05;
/** Décodage FFmpeg d'un extrait, sur une machine chargée par les autres suites. */
const FFMPEG_DECODE_TIMEOUT_MS = 120_000;

describe('SegmentRenderer', () => {
  let assets: MediaAssets;
  let segmentsPerLoop: number;
  const clock: Clock = { now: () => EPOCH };

  beforeAll(async () => {
    assets = await sharedAssets();
    segmentsPerLoop = assets.mire.segments.length;
  });

  const make = (): { chaos: ChaosController; renderer: SegmentRenderer; timeline: LiveTimeline } => {
    const chaos = new ChaosController(clock);
    const timeline = new LiveTimeline(EPOCH, assets.mire.segmentDurationS);
    return { chaos, timeline, renderer: new SegmentRenderer(assets, timeline, chaos, CORRUPT_RATIO) };
  };

  it('produit des PTS vidéo continus, image par image, à travers le rebouclage de la mire', () => {
    const { renderer } = make();
    const ks = [segmentsPerLoop - 2, segmentsPerLoop - 1, segmentsPerLoop, segmentsPerLoop + 1];
    const pts = ks.flatMap((k) =>
      listPes(renderer.render('1', k))
        .filter((p) => isVideoStream(p.streamId))
        .map((p) => p.pts ?? NaN),
    );
    expect(pts.length).toBeGreaterThan(150);
    for (let i = 1; i < pts.length; i++) expect(timestampDelta(pts[i - 1]!, pts[i]!)).toBe(FRAME_TICKS);
  });

  it('produit un audio continu, trame par trame, à travers le rebouclage (amorçage AAC retiré)', () => {
    const { renderer } = make();
    const AAC_FRAME_TICKS = (1024 / 48_000) * 90_000;
    const ks = [segmentsPerLoop - 1, segmentsPerLoop, segmentsPerLoop + 1];
    const pts = ks.flatMap((k) =>
      listPes(renderer.render('1', k))
        .filter((p) => isAudioStream(p.streamId))
        .map((p) => p.pts ?? NaN),
    );
    expect(pts.length).toBeGreaterThan(200);
    for (let i = 1; i < pts.length; i++) expect(timestampDelta(pts[i - 1]!, pts[i]!)).toBe(AAC_FRAME_TICKS);
  });

  it('aligne les PTS sur la timeline murale', () => {
    const { renderer, timeline } = make();
    const k = 1234;
    const first = listPes(renderer.render('1', k)).find((p) => isVideoStream(p.streamId));
    expect(first?.pts).toBe(timeline.ptsAt(timeline.segmentStartMs(k)) % 2 ** 33);
  });

  it('est déterministe et ne modifie jamais les sources', () => {
    const { renderer } = make();
    const before = Buffer.from(assets.mire.segments[3]!);
    expect(
      renderer.render('7', 3 + segmentsPerLoop * 5).equals(renderer.render('7', 3 + segmentsPerLoop * 5)),
    ).toBe(true);
    expect(assets.mire.segments[3]!.equals(before)).toBe(true);
  });

  it('un rendu par tranches de paquets égale le rendu complet', () => {
    const { renderer } = make();
    const asset = renderer.assetFor('1', 40);
    const total = renderer.packetCount(asset, 40);
    const parts = [0, 1, 2, 3].map((i) =>
      renderer.render('1', 40, asset, {
        from: Math.floor((i * total) / 4),
        to: Math.floor(((i + 1) * total) / 4),
      }),
    );
    expect(Buffer.concat(parts).equals(renderer.render('1', 40))).toBe(true);
  });

  it(
    'donne un flux décodable sans erreur par FFmpeg à travers le rebouclage',
    async () => {
      const { renderer } = make();
      const continuity = new ContinuityRewriter();
      const parts = [segmentsPerLoop - 1, segmentsPerLoop, segmentsPerLoop + 1].map((k) => {
        const buf = renderer.render('1', k);
        continuity.rewrite(buf);
        return buf;
      });
      const file = join(await mkdtemp(join(tmpdir(), 'lumen-')), 'wrap.ts');
      await writeFile(file, Buffer.concat(parts));
      const log = await ffmpegAnalyze(file, ['-v', 'error']);
      expect(log.trim()).toBe('');
      // Décodage complet de 6 s de vidéo : rapide seul, mais FFmpeg partage le CPU avec les
      // autres suites lancées en parallèle. Le résultat ne dépend pas du temps, seule la durée.
    },
    FFMPEG_DECODE_TIMEOUT_MS,
  );

  it('gel : PTS vidéo et audio figés pendant la fenêtre, octets inchangés en volume', () => {
    const { renderer, chaos, timeline } = make();
    // Gel de 4 s ouvert à EPOCH, sur la chaîne 1 uniquement.
    chaos.freeze(4000, '1');
    const pes = listPes(renderer.render('1', 0));
    const frozenPts = timeline.ptsAt(EPOCH);
    const video = pes.filter((p) => isVideoStream(p.streamId));
    expect(video.length).toBeGreaterThan(0);
    expect(video.every((p) => p.pts === frozenPts)).toBe(true);
    const audio = pes.filter((p) => isAudioStream(p.streamId));
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.every((p) => p.pts === frozenPts)).toBe(true);
    expect(renderer.render('1', 0).length).toBe(assets.mire.segments[0]!.length);
    // Autre chaîne : non affectée.
    const other = listPes(renderer.render('2', 0)).filter((p) => isVideoStream(p.streamId));
    expect(new Set(other.map((p) => p.pts)).size).toBe(other.length);
    // Après la fenêtre (segment 2 = 4 s → 6 s) : PTS de nouveau en progression.
    const after = listPes(renderer.render('1', 2)).filter((p) => isVideoStream(p.streamId));
    expect(after[0]?.pts).toBe(timeline.ptsAt(timeline.segmentStartMs(2)));
  });

  it('écran noir : segments pris dans la boucle noire, horodatages continus', () => {
    const { renderer, chaos } = make();
    chaos.blackscreen(4000, null);
    expect(renderer.assetFor('1', 0).kind).toBe('black');
    expect(renderer.assetFor('1', 1).kind).toBe('black');
    expect(renderer.assetFor('1', 2).kind).toBe('mire');
    const lastBlack = listPes(renderer.render('1', 1))
      .filter((p) => isVideoStream(p.streamId))
      .at(-1)?.pts;
    const firstMire = listPes(renderer.render('1', 2)).find((p) => isVideoStream(p.streamId))?.pts;
    expect(timestampDelta(lastBlack!, firstMire!)).toBe(FRAME_TICKS);
  });

  it('corruption : contenu altéré, en-têtes TS intacts, tirage stable par segment', () => {
    const { renderer, chaos } = make();
    const clean = renderer.render('1', 5);
    chaos.setCorrupt(1, 42);
    const corrupted = renderer.render('1', 5);
    expect(corrupted.equals(clean)).toBe(false);
    expect(corrupted.equals(renderer.render('1', 5))).toBe(true);
    let altered = 0;
    for (let off = 0; off < clean.length; off += 188) {
      expect(corrupted[off]).toBe(0x47);
      expect(corrupted.subarray(off, off + 4).equals(clean.subarray(off, off + 4))).toBe(true);
      if (!corrupted.subarray(off, off + 188).equals(clean.subarray(off, off + 188))) altered++;
    }
    const packets = clean.length / 188;
    expect(altered).toBeGreaterThan(packets * CORRUPT_RATIO * 0.5);
    expect(altered).toBeLessThan(packets * CORRUPT_RATIO * 2);
  });
});

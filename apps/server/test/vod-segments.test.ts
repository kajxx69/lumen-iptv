import { VOD_TIMELINE_EPOCH_MS } from '@lumen/protocol';
import { describe, expect, it } from 'vitest';
import { MPEG_CLOCK_HZ } from '../src/relay/mpegts.js';
import type { SegmentDraft } from '../src/relay/segmenter.js';
import { defaultAudioTrack, parseProbe } from '../src/vod/probe.js';
import { VodSegments } from '../src/vod/vod-segments.js';

const ORIGIN_S = 1.4;
const draft = (startS: number, durationS: number, discontinuity = false): SegmentDraft => ({
  data: Buffer.alloc(188),
  durationS,
  independent: true,
  discontinuity,
  parts: [],
  startTs: Math.round(startS * MPEG_CLOCK_HZ),
});

const pdt = (playlist: string): number[] =>
  [...playlist.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(.+)/g)].map(
    (m) => (Date.parse(m[1] ?? '') - VOD_TIMELINE_EPOCH_MS) / 1000,
  );

describe('propriétés d un fichier de film (FFprobe)', () => {
  it('durée, début, codecs, pistes audio nommées dans la langue du spectateur', () => {
    const info = parseProbe({
      format: { duration: '5423.120000', start_time: '0.042000' },
      streams: [
        { codec_type: 'video', codec_name: 'png', disposition: { attached_pic: 1 } },
        { codec_type: 'video', codec_name: 'hevc', disposition: {} },
        {
          codec_type: 'audio',
          codec_name: 'ac3',
          channels: 6,
          tags: { language: 'fre' },
          disposition: { default: 0 },
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          channels: 2,
          tags: { language: 'eng' },
          disposition: { default: 1 },
        },
        { codec_type: 'audio', codec_name: 'dts', channels: 2, tags: { title: 'Commentaires' } },
        { codec_type: 'audio', codec_name: 'mp3', tags: { language: 'und' } },
        { codec_type: 'subtitle', codec_name: 'subrip' },
      ],
    });
    expect(info.durationS).toBeCloseTo(5423.12, 2);
    expect(info.startTimeS).toBeCloseTo(0.042, 3);
    // La pochette intégrée n'est pas la vidéo du film.
    expect(info.video).toEqual({ codec: 'hevc' });
    expect(info.audio.map((a) => [a.index, a.codec, a.label])).toEqual([
      [0, 'ac3', 'Français (5.1)'],
      [1, 'aac', 'Anglais'],
      [2, 'other', 'Commentaires'],
      [3, 'mp3', 'Piste 4'],
    ]);
    expect(defaultAudioTrack(info)).toBe(1);
  });

  it('fichier sans durée ni piste désignée : durée inconnue, première piste', () => {
    const info = parseProbe({
      format: { duration: 'N/A' },
      streams: [{ codec_type: 'audio', codec_name: 'aac' }],
    });
    expect(info).toMatchObject({ durationS: null, startTimeS: 0, video: null });
    expect(defaultAudioTrack(info)).toBe(0);
  });
});

describe('segments d une lecture de film', () => {
  const options = { aheadS: 12, behindS: 8, targetDurationS: 4 };
  const origin = Math.round(ORIGIN_S * MPEG_CLOCK_HZ);

  it('chaque segment porte sa position dans le film, origine du fichier retranchée', () => {
    const segs = new VodSegments(options, origin);
    // Reprise à 600 s : les horodatages du fichier sont conservés par FFmpeg.
    segs.add(draft(ORIGIN_S + 600, 4));
    segs.add(draft(ORIGIN_S + 604, 4));
    const playlist = segs.playlist((seq) => `${seq}.ts`);
    expect(pdt(playlist)).toEqual([600, 604]);
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(playlist).not.toContain('#EXT-X-ENDLIST');
  });

  it('fin du fichier : playlist close', () => {
    const segs = new VodSegments(options, origin);
    segs.add(draft(ORIGIN_S, 4));
    segs.end();
    expect(segs.playlist((seq) => `${seq}.ts`)).toMatch(/#EXT-X-ENDLIST\n$/);
  });

  it('avance bornée : pleine au-delà de aheadS devant le dernier segment demandé', () => {
    const segs = new VodSegments(options, origin);
    for (let i = 0; i < 3; i++) segs.add(draft(ORIGIN_S + 4 * i, 4));
    expect(segs.full).toBe(true);
    segs.request(0);
    expect(segs.aheadS()).toBe(8);
    expect(segs.full).toBe(false);
  });

  it('mémoire libérée loin derrière le lecteur ; un segment libéré n est plus servi', () => {
    const segs = new VodSegments(options, origin);
    for (let i = 0; i < 10; i++) segs.add(draft(ORIGIN_S + 4 * i, 4));
    expect(segs.request(9)).not.toBeNull();
    // 8 s gardées derrière le segment 9 : les segments 7 et 8.
    expect(segs.request(8)).not.toBeNull();
    expect(segs.request(7)).not.toBeNull();
    expect(segs.request(6)).toBeNull();
    expect(segs.request(0)).toBeNull();
    // La playlist les annonce toujours : elle ne fait que grandir.
    expect(pdt(segs.playlist((seq) => `${seq}.ts`))).toHaveLength(10);
  });

  it('saut d horodatage dans le fichier : jonction marquée, jamais sur le premier segment', () => {
    const segs = new VodSegments(options, origin);
    segs.add(draft(ORIGIN_S, 4, true));
    segs.add(draft(ORIGIN_S + 30, 4, true));
    const playlist = segs.playlist((seq) => `${seq}.ts`);
    expect(playlist.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(playlist.indexOf('#EXT-X-DISCONTINUITY')).toBeGreaterThan(playlist.indexOf('0.ts'));
  });

  it('durée cible jamais inférieure au plus long segment arrondi', () => {
    const segs = new VodSegments(options, origin);
    segs.add(draft(ORIGIN_S, 6.6));
    expect(segs.playlist((seq) => `${seq}.ts`)).toContain('#EXT-X-TARGETDURATION:7');
  });
});

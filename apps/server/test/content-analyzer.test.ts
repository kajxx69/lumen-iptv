import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/resilience/content-analyzer.js';

const HEADER = `Input #0, mpegts, from 'pipe:0':
  Duration: N/A, start: 3600.040000, bitrate: N/A
  Stream #0:0[0x100]: Video: h264 (Main), yuv420p, 640x360, 25 fps
  Stream #0:1[0x101]: Audio: aac (LC), 48000 Hz, stereo, fltp`;

describe('lecture de la sortie FFmpeg (blackdetect, silencedetect)', () => {
  it('segment entièrement noir et muet', () => {
    const v = parseVerdict(
      `${HEADER}
[blackdetect @ 0x1] black_start:3600.04 black_end:3602.04 black_duration:2
[silencedetect @ 0x2] silence_start: 3600.04`,
      2,
    );
    expect(v).toEqual({ blackS: 2, silentS: 2, hasVideo: true, hasAudio: true });
  });

  it('segment normal : ni noir ni silence', () => {
    expect(parseVerdict(HEADER, 2)).toEqual({ blackS: 0, silentS: 0, hasVideo: true, hasAudio: true });
  });

  it('silence terminé dans le segment : sa durée publiée', () => {
    const v = parseVerdict(
      `${HEADER}
[silencedetect @ 0x2] silence_start: 3600.5
[silencedetect @ 0x2] silence_end: 3601.0 | silence_duration: 0.5`,
      2,
    );
    expect(v.silentS).toBeCloseTo(0.5, 5);
  });

  it('radio : pas de piste vidéo, le noir ne compte pas', () => {
    const v = parseVerdict(
      `Input #0, mpegts, from 'pipe:0':
  Duration: N/A, start: 10.000000, bitrate: N/A
  Stream #0:0[0x101]: Audio: aac (LC), 48000 Hz, stereo, fltp`,
      2,
    );
    expect(v.hasVideo).toBe(false);
    expect(v.hasAudio).toBe(true);
  });
});

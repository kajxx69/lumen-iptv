import { describe, expect, it } from 'vitest';
import { PASSTHROUGH, planOutput } from '../src/transcode/plan.js';

const BASE = { hevc: false, ac3: false, eac3: false };

describe('sortie d un relais : copier ou transcoder', () => {
  it('H.264 + AAC : passthrough, rien ne tourne', () => {
    expect(planOutput({ videoCodec: 'h264', audioCodec: 'aac' }, BASE)).toEqual(PASSTHROUGH);
  });

  it('MP3 (MPEG audio) : lu partout, copié', () => {
    expect(planOutput({ videoCodec: 'h264', audioCodec: 'mp3' }, BASE).audio).toBe('copy');
  });

  it('AC-3 : converti en AAC (peu coûteux), sauf navigateur qui le lit', () => {
    expect(planOutput({ videoCodec: 'h264', audioCodec: 'ac3' }, BASE)).toEqual({
      video: 'copy',
      audio: 'aac',
      key: 'copy+aac',
    });
    expect(planOutput({ videoCodec: 'h264', audioCodec: 'ac3' }, { ...BASE, ac3: true })).toEqual(
      PASSTHROUGH,
    );
  });

  it('E-AC-3 et AAC LATM : convertis', () => {
    expect(planOutput({ videoCodec: 'h264', audioCodec: 'eac3' }, BASE).audio).toBe('aac');
    expect(planOutput({ videoCodec: 'h264', audioCodec: 'other' }, BASE).audio).toBe('aac');
  });

  it('HEVC : copié si le navigateur le décode, transcodé en H.264 sinon', () => {
    expect(planOutput({ videoCodec: 'hevc', audioCodec: 'aac' }, { ...BASE, hevc: true })).toEqual(
      PASSTHROUGH,
    );
    expect(planOutput({ videoCodec: 'hevc', audioCodec: 'aac' }, BASE)).toEqual({
      video: 'h264',
      audio: 'copy',
      key: 'h264+copy',
    });
  });

  it('MPEG-2 : aucun navigateur, toujours transcodé', () => {
    expect(
      planOutput({ videoCodec: 'mpeg2', audioCodec: 'mp3' }, { hevc: true, ac3: true, eac3: true }).video,
    ).toBe('h264');
  });

  it('radio (audio seul) et flux sans audio : rien à transcoder côté vidéo', () => {
    expect(planOutput({ videoCodec: null, audioCodec: 'aac' }, BASE)).toEqual(PASSTHROUGH);
    expect(planOutput({ videoCodec: 'h264', audioCodec: null }, BASE)).toEqual(PASSTHROUGH);
  });
});

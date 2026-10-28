import { describe, expect, it } from 'vitest';
import { SOFTWARE_ENCODER, detectEncoder, probeArgs } from '../src/transcode/encoders.js';
import { transcodeArgs } from '../src/transcode/ffmpeg-args.js';

describe('choix de l encodeur H.264', () => {
  it('le premier encodeur matériel qui fonctionne vraiment', async () => {
    const tried: string[] = [];
    const choice = await detectEncoder('auto', (encoder) => {
      tried.push(encoder);
      return Promise.resolve(encoder === 'h264_qsv');
    });
    expect(choice).toEqual({ encoder: 'h264_qsv', hardware: true });
    expect(tried[0]).toBe('h264_nvenc');
  });

  it('aucun : repli logiciel (libx264), signalé comme tel', async () => {
    expect(await detectEncoder('auto', () => Promise.resolve(false))).toEqual(SOFTWARE_ENCODER);
  });

  it('logiciel imposé : aucun essai matériel', async () => {
    let probed = false;
    const choice = await detectEncoder('software', () => {
      probed = true;
      return Promise.resolve(true);
    });
    expect(choice).toEqual(SOFTWARE_ENCODER);
    expect(probed).toBe(false);
  });

  it('encodeur imposé mais inutilisable : repli logiciel', async () => {
    expect(await detectEncoder('h264_nvenc', () => Promise.resolve(false))).toEqual(SOFTWARE_ENCODER);
    expect(await detectEncoder('h264_nvenc', () => Promise.resolve(true))).toEqual({
      encoder: 'h264_nvenc',
      hardware: true,
    });
  });

  it('essai VAAPI : le périphérique est ouvert avant l entrée', () => {
    const args = probeArgs('h264_vaapi');
    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('format=nv12,hwupload');
  });
});

const OPTIONS = { keyframeIntervalS: 2, maxHeight: 720, audioBitrateKbps: 128 };

describe('arguments FFmpeg d une sortie transcodée', () => {
  it('AC-3 → AAC : la vidéo est copiée, rien n est réencodé', () => {
    const args = transcodeArgs({ video: 'copy', audio: 'aac', key: 'copy+aac' }, SOFTWARE_ENCODER, OPTIONS);
    expect(args.join(' ')).toContain('-c:v copy');
    expect(args.join(' ')).toContain('-c:a aac -b:a 128k -ac 2');
    expect(args).not.toContain('-force_key_frames');
    // Entrée et sortie MPEG-TS par tuyaux : le relais l'alimente et la découpe.
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', 'pipe:0']);
    expect(args.at(-1)).toBe('pipe:1');
  });

  it('vidéo → H.264 logiciel : réduite à 720p au plus, image clé toutes les 2 s', () => {
    const args = transcodeArgs({ video: 'h264', audio: 'copy', key: 'h264+copy' }, SOFTWARE_ENCODER, OPTIONS);
    const line = args.join(' ');
    expect(line).toContain('-c:v libx264');
    expect(line).toContain("scale=-2:'min(720,ih)'");
    expect(line).toContain('-force_key_frames expr:gte(t,n_forced*2)');
    expect(line).toContain('-tune zerolatency');
    expect(line).toContain('-c:a copy');
  });

  it('vidéo → H.264 matériel (NVENC) : réglages de l encodeur matériel', () => {
    const line = transcodeArgs(
      { video: 'h264', audio: 'aac', key: 'h264+aac' },
      { encoder: 'h264_nvenc', hardware: true },
      OPTIONS,
    ).join(' ');
    expect(line).toContain('-c:v h264_nvenc');
    expect(line).not.toContain('libx264');
  });

  it('VAAPI : mise à l échelle sur le GPU, périphérique ouvert avant l entrée', () => {
    const args = transcodeArgs(
      { video: 'h264', audio: 'copy', key: 'h264+copy' },
      { encoder: 'h264_vaapi', hardware: true },
      OPTIONS,
    );
    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    expect(args.join(' ')).toContain('hwupload');
  });
});

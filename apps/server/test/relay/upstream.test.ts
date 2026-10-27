import { describe, expect, it } from 'vitest';
import { FailoverPolicy, type FailoverOptions } from '../../src/relay/failover.js';
import { parsePlaylist, pickVariant } from '../../src/relay/hls-parser.js';

describe('analyse des playlists HLS amont', () => {
  it('playlist de médias : séquence, durées, discontinuités, URI absolues', () => {
    const parsed = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:98000',
        '#EXTINF:4.000,',
        'seg-98000.ts?t=abc',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:3.5,titre',
        '/abs/seg-98001.ts',
        '#EXTINF:4,',
        'https://cdn.example/seg-98002.ts',
      ].join('\r\n'),
      'http://up.example/live/ch1/index.m3u8?token=x',
    );
    expect(parsed).toEqual({
      kind: 'media',
      targetDurationS: 4,
      mediaSequence: 98000,
      endList: false,
      initSegment: false,
      segments: [
        {
          seq: 98000,
          durationS: 4,
          discontinuity: false,
          uri: 'http://up.example/live/ch1/seg-98000.ts?t=abc',
        },
        { seq: 98001, durationS: 3.5, discontinuity: true, uri: 'http://up.example/abs/seg-98001.ts' },
        { seq: 98002, durationS: 4, discontinuity: false, uri: 'https://cdn.example/seg-98002.ts' },
      ],
    });
  });

  it('playlist maîtresse : variantes, la plus haute qualité est choisie', () => {
    const parsed = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        'low/index.m3u8',
        '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3000000,RESOLUTION=1280x720',
        'high/index.m3u8',
      ].join('\n'),
      'http://up.example/live/master.m3u8',
    );
    expect(parsed.kind).toBe('master');
    if (parsed.kind !== 'master') return;
    expect(pickVariant(parsed.variants)?.uri).toBe('http://up.example/live/high/index.m3u8');
  });

  it('fin de liste et segments fMP4 (EXT-X-MAP) signalés', () => {
    const parsed = parsePlaylist(
      ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:2,', 'a.m4s', '#EXT-X-ENDLIST'].join('\n'),
      'http://up.example/x.m3u8',
    );
    expect(parsed).toMatchObject({ kind: 'media', endList: true, initSegment: true, mediaSequence: 0 });
  });

  it('refuse ce qui n est pas une playlist', () => {
    expect(() => parsePlaylist('<html>quota dépassé</html>', 'http://up.example/x.m3u8')).toThrow();
  });
});

const OPTIONS: FailoverOptions = {
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  bufferedMaxDelayMs: 2000,
  jitterRatio: 0.2,
};
const noJitter = (): number => 0.5;

describe('politique de reconnexion et de bascule', () => {
  it('source unique : nouveau lien immédiat, puis attente exponentielle plafonnée', () => {
    const p = new FailoverPolicy(() => 1, OPTIONS, noJitter);
    const fail = { produced: false, bufferedAhead: false };
    expect(p.next(fail)).toEqual({ source: 0, delayMs: 0, reason: 'reconnect' });
    const delays = Array.from({ length: 9 }, () => p.next(fail).delayMs);
    expect(delays).toEqual([200, 400, 800, 1600, 3200, 6400, 10_000, 10_000, 10_000]);
  });

  it('tant que des spectateurs ont du tampon, les tentatives restent rapprochées', () => {
    const p = new FailoverPolicy(() => 1, OPTIONS, noJitter);
    const fail = { produced: false, bufferedAhead: true };
    p.next(fail);
    const delays = Array.from({ length: 6 }, () => p.next(fail).delayMs);
    expect(delays).toEqual([200, 400, 800, 1600, 2000, 2000]);
  });

  it('deux sources : nouveau lien sur la même, puis bascule, puis attente sur l origine', () => {
    const p = new FailoverPolicy(() => 2, OPTIONS, noJitter);
    const fail = { produced: false, bufferedAhead: false };
    expect(p.next(fail)).toEqual({ source: 0, delayMs: 0, reason: 'reconnect' });
    expect(p.next(fail)).toEqual({ source: 1, delayMs: 0, reason: 'switch' });
    expect(p.next(fail)).toEqual({ source: 1, delayMs: 0, reason: 'reconnect' });
    expect(p.next(fail)).toEqual({ source: 0, delayMs: 200, reason: 'backoff' });
    // Tours suivants : plus de double tentative, chaque source une fois par tour.
    expect(p.next(fail)).toEqual({ source: 1, delayMs: 0, reason: 'switch' });
    expect(p.next(fail)).toEqual({ source: 0, delayMs: 400, reason: 'backoff' });
  });

  it('une connexion qui a produit des segments remet les compteurs à zéro', () => {
    const p = new FailoverPolicy(() => 2, OPTIONS, noJitter);
    const fail = { produced: false, bufferedAhead: false };
    p.next(fail);
    p.next(fail); // → source 1
    expect(p.next({ produced: true, bufferedAhead: true })).toEqual({
      source: 1,
      delayMs: 0,
      reason: 'reconnect',
    });
    expect(p.next(fail)).toEqual({ source: 0, delayMs: 0, reason: 'switch' });
  });

  it('bascule demandée (gel détecté, test) : source suivante sans attendre', () => {
    const p = new FailoverPolicy(() => 3, OPTIONS, noJitter);
    expect(p.next({ produced: true, bufferedAhead: true, switchRequested: true })).toEqual({
      source: 1,
      delayMs: 0,
      reason: 'switch',
    });
  });

  it('gigue aléatoire autour du délai nominal', () => {
    const low = new FailoverPolicy(
      () => 1,
      OPTIONS,
      () => 0,
    );
    const high = new FailoverPolicy(
      () => 1,
      OPTIONS,
      () => 0.999_999,
    );
    const fail = { produced: false, bufferedAhead: false };
    low.next(fail);
    high.next(fail);
    expect(low.next(fail).delayMs).toBe(160);
    expect(high.next(fail).delayMs).toBe(240);
  });
});

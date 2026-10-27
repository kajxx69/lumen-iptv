import { describe, expect, it } from 'vitest';
import { renderPlaylist } from '../../src/relay/playlist.js';
import { SegmentCache } from '../../src/relay/segment-cache.js';
import { type RelaySegment, SegmentWindow } from '../../src/relay/segment-window.js';

const T0 = Date.UTC(2026, 9, 27, 20, 0, 0);

const draft = (durationS: number, discontinuity = false, bytes = 10) => ({
  data: Buffer.alloc(bytes, 1),
  durationS,
  discontinuity,
  independent: true,
  sourceId: 'a',
});

describe('fenêtre glissante de segments', () => {
  it('numérotation continue et éviction par durée : toujours au moins la capacité en mémoire', () => {
    const evicted: number[] = [];
    const w = new SegmentWindow(10, (s) => evicted.push(s.seq));
    for (let i = 0; i < 8; i++) w.append(draft(2), T0 + i * 2000);
    expect(w.segments.map((s) => s.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(w.mediaSequence).toBe(3);
    expect(w.bufferedS).toBe(10);
    expect(evicted).toEqual([0, 1, 2]);
    expect(w.get(1)).toBeUndefined();
    expect(w.get(5)?.seq).toBe(5);
  });

  it('fenêtre vide : la séquence suivante est annoncée', () => {
    const w = new SegmentWindow(10);
    expect(w.mediaSequence).toBe(0);
    expect(w.segments).toHaveLength(0);
  });

  it('DISCONTINUITY-SEQUENCE augmente quand une jonction sort de la fenêtre', () => {
    const w = new SegmentWindow(4);
    w.append(draft(2), T0);
    w.append(draft(2), T0 + 2000);
    w.append(draft(2, true), T0 + 4000); // jonction : source B
    expect(w.discontinuitySequence).toBe(0);
    w.append(draft(2), T0 + 6000);
    // seq 0 et 1 évincés : la jonction (seq 2) est maintenant en tête, toujours listée.
    expect(w.segments.map((s) => s.seq)).toEqual([2, 3]);
    expect(w.discontinuitySequence).toBe(0);
    w.append(draft(2), T0 + 8000);
    expect(w.segments.map((s) => s.seq)).toEqual([3, 4]);
    expect(w.discontinuitySequence).toBe(1);
  });

  it('une discontinuité sur le tout premier segment est sans objet', () => {
    const w = new SegmentWindow(10);
    expect(w.append(draft(2, true), T0).discontinuity).toBe(false);
  });

  it('horodatage PROGRAM-DATE-TIME continu dans une même source, recalé sur l horloge à la jonction', () => {
    const w = new SegmentWindow(60);
    const a = w.append(draft(2), T0);
    const b = w.append(draft(2), T0 + 2500); // arrivé en retard : l'horodatage reste contigu
    const c = w.append(draft(2, true), T0 + 30_000);
    expect(b.programDateTimeMs - a.programDateTimeMs).toBe(2000);
    expect(c.programDateTimeMs).toBe(T0 + 30_000 - 2000);
    // Jamais de retour en arrière, même si l'horloge murale est en retard sur le contenu.
    const d = w.append(draft(2, true), T0 + 30_100);
    expect(d.programDateTimeMs).toBeGreaterThanOrEqual(c.programDateTimeMs + 2000);
  });
});

describe('playlist générée', () => {
  const segments = (): RelaySegment[] => {
    const w = new SegmentWindow(60);
    w.append(draft(2.002), T0);
    w.append(draft(1.968), T0 + 2000);
    w.append(draft(2.04, true), T0 + 9310);
    return [...w.segments];
  };

  it('format exact : séquence, jonction, horodatages, URI relatives', () => {
    const text = renderPlaylist(
      { mediaSequence: 1041, discontinuitySequence: 3, segments: segments(), targetDurationS: 6 },
      (seq) => `seg/${seq}.ts`,
    );
    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:1041',
        '#EXT-X-DISCONTINUITY-SEQUENCE:3',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-27T19:59:57.998Z',
        '#EXTINF:2.002,',
        'seg/0.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-27T20:00:00.000Z',
        '#EXTINF:1.968,',
        'seg/1.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-27T20:00:07.270Z',
        '#EXTINF:2.040,',
        'seg/2.ts',
        '',
      ].join('\n'),
    );
  });

  it('rechargement bloquant annoncé : le lecteur voit chaque nouveau segment à l instant où il paraît', () => {
    const text = renderPlaylist(
      {
        mediaSequence: 0,
        discontinuitySequence: 0,
        segments: segments(),
        targetDurationS: 6,
        blockingReload: { holdBackS: 20 },
      },
      (seq) => `seg/${seq}.ts`,
    );
    expect(text).toContain('#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,HOLD-BACK=20.000\n');
    expect(text.indexOf('SERVER-CONTROL')).toBeLessThan(text.indexOf('#EXTINF'));
  });

  it('TARGETDURATION ne descend jamais sous un segment (règle RFC 8216)', () => {
    const text = renderPlaylist(
      { mediaSequence: 0, discontinuitySequence: 0, segments: segments(), targetDurationS: 1 },
      (seq) => `seg/${seq}.ts`,
    );
    expect(text).toContain('#EXT-X-TARGETDURATION:2\n');
  });
});

describe('cache LRU des segments évincés', () => {
  it('borné en octets, le moins récemment lu part en premier', () => {
    const cache = new SegmentCache(25);
    cache.put('r', 1, Buffer.alloc(10));
    cache.put('r', 2, Buffer.alloc(10));
    expect(cache.get('r', 1)?.length).toBe(10); // 1 devient le plus récent
    cache.put('r', 3, Buffer.alloc(10));
    expect(cache.get('r', 2)).toBeUndefined();
    expect(cache.get('r', 1)).toBeDefined();
    expect(cache.get('r', 3)).toBeDefined();
    expect(cache.bytes).toBe(20);
  });

  it('un segment plus gros que le cache n est pas conservé', () => {
    const cache = new SegmentCache(5);
    cache.put('r', 1, Buffer.alloc(10));
    expect(cache.get('r', 1)).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('oublie tous les segments d un relais fermé', () => {
    const cache = new SegmentCache(100);
    cache.put('a', 1, Buffer.alloc(10));
    cache.put('b', 1, Buffer.alloc(10));
    cache.forget('a');
    expect(cache.get('a', 1)).toBeUndefined();
    expect(cache.get('b', 1)).toBeDefined();
    expect(cache.bytes).toBe(10);
  });
});

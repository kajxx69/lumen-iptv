import { describe, expect, it, vi } from 'vitest';
import { SessionView, type ViewSource } from '../src/playback/session-view.js';
import { SegmentWindow } from '../src/relay/segment-window.js';
import { parsePlaylist } from '../src/relay/hls-parser.js';

const CLOCK = 90_000;
const T0 = Date.UTC(2026, 9, 28, 20, 0, 0);
const SETTINGS = { targetDurationS: 6, holdBackS: 20, partTargetS: 0.5, partHoldBackS: 1.5 };

/** Sortie simulée : une fenêtre de segments réelle, alimentée à la main. */
class FakeOutput implements ViewSource {
  readonly window = new SegmentWindow(60);
  private waiters: (() => void)[] = [];

  constructor(readonly name: string) {}

  /** Segment de `durationS` commençant à l'horodatage `startS` (secondes de flux). */
  add(startS: number, durationS: number, independent = true, discontinuity = false): void {
    this.window.append(
      {
        data: Buffer.from(`${this.name}@${startS}`),
        durationS,
        independent,
        discontinuity,
        parts: [],
        startTs: Math.round(startS * CLOCK),
        sourceId: 'a',
      },
      T0 + startS * 1000,
    );
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  get nextSeq(): number {
    return (this.window.segments.at(-1)?.seq ?? this.window.mediaSequence - 1) + 1;
  }

  segment(seq: number): Buffer | undefined {
    return this.window.get(seq)?.data;
  }

  part(): Buffer | undefined {
    return undefined;
  }

  waitFor(seq: number): Promise<void> {
    if (seq < this.nextSeq) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const uri = (seq: number, part?: number): string =>
  part === undefined ? `seg/${seq}.ts` : `seg/${seq}.${part}.ts`;
const listed = (view: SessionView) => {
  const p = parsePlaylist(view.playlist(uri, false), 'http://x/index.m3u8');
  if (p.kind !== 'media') throw new Error('playlist inattendue');
  return p;
};
const names = (view: SessionView): string[] =>
  listed(view).segments.map((s) => view.segment(s.seq)?.toString() ?? '?');

describe('vue de lecture d une session', () => {
  it('reprend la fenêtre de la sortie : un relais chaud donne tout son tampon', () => {
    const out = new FakeOutput('src');
    for (let i = 0; i < 5; i++) out.add(i * 2, 2);
    const view = new SessionView(out, 30, SETTINGS);
    const p = listed(view);
    expect(p.segments.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(names(view)).toEqual(['src@0', 'src@2', 'src@4', 'src@6', 'src@8']);
  });

  it('suit les nouveaux segments de sa sortie', () => {
    const out = new FakeOutput('src');
    out.add(0, 2);
    const view = new SessionView(out, 30, SETTINGS);
    out.add(2, 2);
    expect(names(view)).toEqual(['src@0', 'src@2']);
  });

  it('changement de sortie : reprend juste après ce qui a été joué, numérotation continue, jonction marquée', () => {
    const src = new FakeOutput('src');
    const low = new FakeOutput('360p');
    for (let i = 0; i < 3; i++) src.add(i * 2, 2);
    for (let i = 0; i < 4; i++) low.add(i * 2, 2);
    const view = new SessionView(src, 30, SETTINGS);
    expect(names(view)).toEqual(['src@0', 'src@2', 'src@4']);
    view.switchTo(low);
    const p = listed(view);
    expect(names(view)).toEqual(['src@0', 'src@2', 'src@4', '360p@6']);
    expect(p.segments.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    expect(p.segments.map((s) => s.discontinuity)).toEqual([false, false, false, true]);
    // La suite vient de la nouvelle sortie.
    low.add(8, 2);
    expect(names(view).slice(-2)).toEqual(['360p@6', '360p@8']);
  });

  it('nouvelle sortie en retard : l ancienne est retenue un moment, puis avance si l attente dure', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const src = new FakeOutput('src');
      const low = new FakeOutput('360p');
      src.add(0, 2);
      src.add(2, 2);
      low.add(0, 2);
      const view = new SessionView(src, 30, SETTINGS);
      view.switchTo(low);
      src.add(4, 2);
      // Retenue : la sortie transcodée a toujours un peu de retard, on lui laisse rattraper.
      expect(names(view)).toEqual(['src@0', 'src@2']);
      // Attente trop longue : l'image source avance d'un cran plutôt que de priver le lecteur.
      vi.advanceTimersByTime(4100);
      expect(names(view)).toEqual(['src@0', 'src@2', 'src@4']);
      low.add(2, 2);
      low.add(4, 2);
      low.add(6, 2);
      expect(names(view).slice(-1)).toEqual(['360p@6']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('la sortie à rejoindre rattrape son retard : changement au segment exact qui suit', () => {
    const src = new FakeOutput('src');
    const low = new FakeOutput('360p');
    src.add(0, 2);
    src.add(2, 2);
    const view = new SessionView(src, 30, SETTINGS);
    view.switchTo(low);
    src.add(4, 2);
    low.add(2, 2);
    low.add(4, 2);
    expect(names(view)).toEqual(['src@0', 'src@2', '360p@4']);
  });

  it('on ne rejoint une sortie que sur une image clé', () => {
    const src = new FakeOutput('src');
    const low = new FakeOutput('360p');
    src.add(0, 2);
    low.add(2, 0.5, false);
    low.add(2.5, 1.5, true);
    const view = new SessionView(src, 30, SETTINGS);
    view.switchTo(low);
    expect(names(view)).toEqual(['src@0', '360p@2.5']);
  });

  it('fenêtre bornée, DISCONTINUITY-SEQUENCE suivie quand une jonction sort', () => {
    const src = new FakeOutput('src');
    const low = new FakeOutput('360p');
    src.add(0, 2);
    const view = new SessionView(src, 6, SETTINGS);
    view.switchTo(low);
    for (let i = 1; i < 8; i++) low.add(i * 2, 2);
    const p = listed(view);
    expect(p.segments.length).toBeLessThanOrEqual(4);
    expect(view.playlist(uri, false)).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1\n');
  });

  it('rechargement bloquant : attend le segment suivant de la sortie en cours', async () => {
    const src = new FakeOutput('src');
    src.add(0, 2);
    const view = new SessionView(src, 30, SETTINGS);
    let done = false;
    const wait = view.waitFor(1, undefined, 5000).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    src.add(2, 2);
    await wait;
    expect(view.nextSeq).toBe(2);
  });
});

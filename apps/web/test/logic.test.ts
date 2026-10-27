import type { EpgEntryDto } from '@lumen/protocol';
import { describe, expect, it } from 'vitest';
import { guideWindow, layoutProgrammes, nowNext } from '../src/epg/layout.js';
import { pickNeighbor, type Rect } from '../src/nav/spatial.js';
import { LIVE_DELAY, liveRate } from '../src/player/live-delay.js';

const box = (left: number, top: number, width = 100, height = 40): Rect => ({ left, top, width, height });

describe('navigation spatiale (D-pad)', () => {
  // Grille 3 × 2 : deux lignes de trois tuiles.
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 60), box(120, 60), box(240, 60)];

  it('droite, gauche, bas, haut dans une grille', () => {
    expect(pickNeighbor(grid[0]!, grid, 'right')).toBe(1);
    expect(pickNeighbor(grid[1]!, grid, 'left')).toBe(0);
    expect(pickNeighbor(grid[1]!, grid, 'down')).toBe(4);
    expect(pickNeighbor(grid[5]!, grid, 'up')).toBe(2);
  });

  it('aucun voisin au bord : -1', () => {
    expect(pickNeighbor(grid[0]!, grid, 'left')).toBe(-1);
    expect(pickNeighbor(grid[0]!, grid, 'up')).toBe(-1);
  });

  it('préfère le voisin aligné au voisin proche mais en biais', () => {
    const from = box(0, 100);
    const aligned = box(250, 100);
    const diagonal = box(120, 0);
    expect(pickNeighbor(from, [diagonal, aligned], 'right')).toBe(1);
  });

  it('d une liste verticale vers une colonne voisine plus haute', () => {
    const sidebarItem = box(0, 300, 200, 40);
    const tallList = box(220, 0, 600, 800);
    expect(pickNeighbor(sidebarItem, [tallList], 'right')).toBe(0);
  });
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 20, 10);
const entry = (id: string, start: number, end: number): EpgEntryDto => ({
  id,
  title: id,
  description: '',
  category: '',
  start,
  end,
  catchup: false,
});

describe('guide des programmes', () => {
  it('fenêtre alignée sur la demi-heure', () => {
    expect(guideWindow(T0, 3)).toEqual({
      start: Date.UTC(2026, 9, 27, 20, 0),
      end: Date.UTC(2026, 9, 27, 23, 0),
    });
  });

  it('blocs positionnés et coupés aux bords de la fenêtre', () => {
    const win = guideWindow(T0, 2);
    const blocks = layoutProgrammes(
      [
        entry('après', win.start + HOUR, win.start + 3 * HOUR),
        entry('avant', win.start - HOUR, win.start + HOUR / 2),
        entry('hors', win.end + HOUR, win.end + 2 * HOUR),
      ],
      win,
      4,
      T0,
    );
    expect(blocks.map((b) => [b.entry.id, b.left, b.width, b.live])).toEqual([
      ['avant', 0, 120, true],
      ['après', 240, 240, false],
    ]);
  });

  it('programme en cours, suivant et avancement', () => {
    const list = [entry('b', T0 + HOUR, T0 + 2 * HOUR), entry('a', T0 - HOUR / 2, T0 + HOUR)];
    const nn = nowNext(list, T0);
    expect(nn.now?.id).toBe('a');
    expect(nn.next?.id).toBe('b');
    expect(nn.progress).toBeCloseTo(1 / 3, 5);
  });

  it('trou dans la grille : pas de programme en cours, le suivant reste annoncé', () => {
    const nn = nowNext([entry('plus tard', T0 + HOUR, T0 + 2 * HOUR)], T0);
    expect(nn.now).toBeNull();
    expect(nn.next?.id).toBe('plus tard');
    expect(nn.progress).toBe(0);
  });
});

describe('retard volontaire sur le direct', () => {
  const rate = (latencyS: number | null, bufferAheadS = 10, currentRate = 1): number =>
    liveRate({ latencyS, bufferAheadS, currentRate });

  it('trop près du direct avec du tampon : ralentit légèrement', () => {
    expect(rate(5)).toBe(LIVE_DELAY.slowRate);
  });

  it('cible atteinte : vitesse normale', () => {
    expect(rate(20, 10, LIVE_DELAY.slowRate)).toBe(1);
    expect(rate(25)).toBe(1);
  });

  it('hystérésis : pas de va-et-vient autour de la cible', () => {
    expect(rate(19.5, 10, 1)).toBe(1);
    expect(rate(19.5, 10, LIVE_DELAY.slowRate)).toBe(LIVE_DELAY.slowRate);
  });

  it('tampon trop maigre ou retard inconnu : jamais ralentir', () => {
    expect(rate(5, 1)).toBe(1);
    expect(rate(null)).toBe(1);
  });
});

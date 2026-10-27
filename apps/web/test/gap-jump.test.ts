import { describe, expect, it } from 'vitest';
import { GAP_JUMP, stallEscapeTarget } from '../src/player/gap-jump.js';

const r = (start: number, end: number) => ({ start, end });

describe('stallEscapeTarget (image bloquée au changement de source)', () => {
  it('saute un petit trou entre deux plages (DISCONTINUITY)', () => {
    const target = stallEscapeTarget([r(0, 10), r(10.3, 20)], 9.98);
    expect(target).not.toBeNull();
    expect(target).toBeGreaterThanOrEqual(10.3);
    expect(target).toBeLessThan(10.3 + 0.2);
  });

  it('saute aussi quand la tête est déjà dans le trou', () => {
    expect(stallEscapeTarget([r(0, 10), r(10.5, 20)], 10.1)).toBeGreaterThanOrEqual(10.5);
  });

  it('ne saute pas un trou trop grand : ce serait une coupure visible', () => {
    expect(stallEscapeTarget([r(0, 10), r(10 + GAP_JUMP.maxGapS + 1, 30)], 9.99)).toBeNull();
  });

  it('rien à faire sans plage suivante (simple attente de données)', () => {
    expect(stallEscapeTarget([r(0, 10)], 9.99)).toBeNull();
  });

  it('ignore les plages déjà passées', () => {
    expect(stallEscapeTarget([r(0, 5), r(5.2, 10)], 9.99)).toBeNull();
  });

  it('bloquée alors que des données suivent : avance d un pas imperceptible', () => {
    const target = stallEscapeTarget([r(0, 4)], 1.95);
    expect(target).toBeCloseTo(1.95 + GAP_JUMP.nudgeS);
  });

  it('pas de pas en avant qui sortirait des données reçues', () => {
    expect(stallEscapeTarget([r(0, 2)], 1.95)).toBeNull();
  });
});

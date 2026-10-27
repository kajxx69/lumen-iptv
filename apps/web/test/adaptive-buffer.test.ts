import { describe, expect, it } from 'vitest';
import { ADAPTIVE_BUFFER, AdaptiveBuffer } from '../src/player/adaptive-buffer.js';

const T0 = 1_000_000;
const S = 1000;

describe('tampon client adaptatif', () => {
  it('réseau stable : le retard visé reste au plancher', () => {
    const b = new AdaptiveBuffer();
    for (let i = 0; i < 20; i++) b.fragmentLoaded(T0 + i * 2 * S, 0.3, 2);
    expect(b.targetS(T0 + 40 * S)).toBe(ADAPTIVE_BUFFER.baseS);
  });

  it('une coupure de lecture fait monter le retard visé', () => {
    const b = new AdaptiveBuffer();
    b.stalled(T0);
    expect(b.targetS(T0)).toBe(ADAPTIVE_BUFFER.baseS + ADAPTIVE_BUFFER.stallStepS);
  });

  it('gigue : des segments qui mettent plus de la moitié de leur durée à arriver', () => {
    const b = new AdaptiveBuffer();
    for (let i = 0; i < 10; i++) b.fragmentLoaded(T0 + i * 2 * S, 1.4, 2);
    expect(b.targetS(T0 + 20 * S)).toBeGreaterThan(ADAPTIVE_BUFFER.baseS);
  });

  it('jamais au-delà de 60 s', () => {
    const b = new AdaptiveBuffer();
    for (let i = 0; i < 20; i++) b.stalled(T0 + i);
    expect(b.targetS(T0 + 20)).toBe(ADAPTIVE_BUFFER.maxS);
  });

  it('décroissance lente quand le flux redevient stable', () => {
    const b = new AdaptiveBuffer();
    for (let i = 0; i < 4; i++) b.stalled(T0);
    const high = b.targetS(T0);
    const later = b.targetS(T0 + 5 * 60 * S);
    expect(later).toBeLessThan(high);
    expect(later).toBeGreaterThan(ADAPTIVE_BUFFER.baseS);
    expect(b.targetS(T0 + 60 * 60 * S)).toBe(ADAPTIVE_BUFFER.baseS);
  });

  it('mesure du temps passé à attendre (ratio de rebuffering)', () => {
    const b = new AdaptiveBuffer();
    b.stalled(T0);
    b.resumed(T0 + 1500);
    b.stalled(T0 + 10 * S);
    b.resumed(T0 + 10 * S + 500);
    expect(b.takeStalledMs()).toBe(2000);
    expect(b.takeStalledMs()).toBe(0);
  });
});

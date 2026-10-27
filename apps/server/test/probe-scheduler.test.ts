import { describe, expect, it } from 'vitest';
import { type ProbeOptions, ProbeScheduler } from '../src/resilience/probe-scheduler.js';
import type { SourceRef } from '../src/resilience/health-service.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 27 octobre 2026, 20 h heure locale du serveur de test.
const EVENING = new Date(2026, 9, 27, 20, 0).getTime();
const NIGHT = new Date(2026, 9, 28, 3, 0).getTime();

const OPTIONS: ProbeOptions = {
  favoritesIntervalMs: 15 * MIN,
  catalogStartHour: 3,
  catalogEndHour: 6,
  catalogProbesPerHour: 600,
};

const ref = (portalId: string, channelId: string): SourceRef => ({ portalId, channelId });

function scheduler(
  favorites: SourceRef[],
  catalog: SourceRef[] = [],
  busy: Set<string> = new Set(),
): ProbeScheduler {
  return new ProbeScheduler(OPTIONS, {
    favorites: () => favorites,
    catalog: () => catalog,
    portalBusy: (portalId) => busy.has(portalId),
  });
}

describe('planification des sondes de fond', () => {
  it('favoris : chacun sondé, puis pas avant 15 min', () => {
    const s = scheduler([ref('p', '1'), ref('p', '2')]);
    expect(s.next(EVENING)).toEqual(ref('p', '1'));
    s.done(ref('p', '1'), EVENING);
    expect(s.next(EVENING)).toEqual(ref('p', '2'));
    s.done(ref('p', '2'), EVENING);
    expect(s.next(EVENING + 10 * MIN)).toBeNull();
    expect(s.next(EVENING + 15 * MIN)).toEqual(ref('p', '1'));
  });

  it('jamais sur un portail où quelqu un regarde (une MAC = peu de connexions)', () => {
    const s = scheduler([ref('occupé', '1'), ref('libre', '2')], [], new Set(['occupé']));
    expect(s.next(EVENING)).toEqual(ref('libre', '2'));
  });

  it('catalogue complet : seulement la nuit, au rythme permis', () => {
    const catalog = [ref('p', '10'), ref('p', '11'), ref('p', '12')];
    const s = scheduler([], catalog);
    expect(s.next(EVENING)).toBeNull();
    expect(s.next(NIGHT)).toEqual(ref('p', '10'));
    s.done(ref('p', '10'), NIGHT);
    // 600 sondes par heure : une toutes les 6 s.
    expect(s.next(NIGHT + 1000)).toBeNull();
    expect(s.next(NIGHT + 6000)).toEqual(ref('p', '11'));
  });

  it('balayage nocturne : reprend où il s était arrêté, une fois par nuit', () => {
    const catalog = [ref('p', '10'), ref('p', '11')];
    const s = scheduler([], catalog);
    let t = NIGHT;
    for (const r of catalog) {
      expect(s.next(t)).toEqual(r);
      s.done(r, t);
      t += 6000;
    }
    // Catalogue fini cette nuit : rien jusqu'à la nuit suivante.
    expect(s.next(t + HOUR)).toBeNull();
    expect(s.next(NIGHT + 24 * HOUR)).toEqual(ref('p', '10'));
  });

  it('les favoris passent avant le balayage nocturne', () => {
    const s = scheduler([ref('p', 'fav')], [ref('p', '10')]);
    expect(s.next(NIGHT)).toEqual(ref('p', 'fav'));
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_OPTIONS,
  HealthTracker,
  type SourceHealth,
  rankSources,
  scoreHealth,
} from '../../resilience/index.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const perfect: Omit<SourceHealth, 'score'> = {
  resolveLatencyMs: 200,
  timeToFirstByteMs: 300,
  segmentFailureRate: 0,
  bitrateJitter: 0.05,
  freezeEventsPerHour: 0,
  contentEventsPerHour: 0,
  uptime24h: 1,
  samples: 50,
};

describe('score de santé', () => {
  it('source parfaite : 100', () => {
    expect(scoreHealth(perfect)).toBe(100);
  });

  it('chaque défaut retire des points, jamais sous 0', () => {
    expect(scoreHealth({ ...perfect, resolveLatencyMs: 5000 })).toBe(85);
    expect(scoreHealth({ ...perfect, timeToFirstByteMs: 5000 })).toBe(85);
    expect(scoreHealth({ ...perfect, segmentFailureRate: 0.4 })).toBe(90);
    expect(scoreHealth({ ...perfect, bitrateJitter: 1 })).toBe(90);
    expect(scoreHealth({ ...perfect, freezeEventsPerHour: 1 })).toBe(85);
    expect(scoreHealth({ ...perfect, contentEventsPerHour: 1 })).toBe(80);
    expect(scoreHealth({ ...perfect, uptime24h: 0.5 })).toBe(85);
    expect(
      scoreHealth({
        resolveLatencyMs: 10_000,
        timeToFirstByteMs: 10_000,
        segmentFailureRate: 1,
        bitrateJitter: 3,
        freezeEventsPerHour: 10,
        contentEventsPerHour: 10,
        uptime24h: 0,
        samples: 10,
      }),
    ).toBe(0);
  });

  it('source jamais essayée : score prudent, sous une source connue et saine', () => {
    const unknown = scoreHealth({ ...perfect, samples: 0 });
    expect(unknown).toBeLessThan(100);
    expect(unknown).toBeGreaterThan(scoreHealth({ ...perfect, contentEventsPerHour: 1 }));
  });
});

describe('suivi des événements', () => {
  it('sans événement : santé inconnue', () => {
    const h = new HealthTracker().health(T0);
    expect(h.samples).toBe(0);
    expect(h.uptime24h).toBe(1);
    expect(h.score).toBe(scoreHealth({ ...h }));
  });

  it('latences : moyenne des dernières mesures', () => {
    const t = new HealthTracker();
    t.record({ kind: 'resolve', at: T0, ms: 100, ok: true });
    t.record({ kind: 'resolve', at: T0 + 1, ms: 300, ok: true });
    t.record({ kind: 'firstByte', at: T0 + 2, ms: 400 });
    const h = t.health(T0 + 3);
    expect(h.resolveLatencyMs).toBe(200);
    expect(h.timeToFirstByteMs).toBe(400);
  });

  it('taux d échec des segments sur 5 minutes glissantes', () => {
    const t = new HealthTracker();
    t.record({ kind: 'segment', at: T0, ok: false });
    for (let i = 1; i <= 3; i++) t.record({ kind: 'segment', at: T0 + 6 * MIN + i, ok: i !== 1 });
    // L'échec à T0 est sorti de la fenêtre ; il reste 1 échec sur 3.
    expect(t.health(T0 + 6 * MIN + 10).segmentFailureRate).toBeCloseTo(1 / 3, 5);
  });

  it('gigue de débit : coefficient de variation', () => {
    const t = new HealthTracker();
    for (const kbps of [1000, 1000, 1000, 1000])
      t.record({ kind: 'segment', at: T0, ok: true, bitrateKbps: kbps });
    expect(t.health(T0).bitrateJitter).toBe(0);
    t.record({ kind: 'segment', at: T0, ok: true, bitrateKbps: 3000 });
    expect(t.health(T0).bitrateJitter).toBeGreaterThan(0.5);
  });

  it('gels et pannes de contenu comptés sur l heure écoulée', () => {
    const t = new HealthTracker();
    t.record({ kind: 'freeze', at: T0 });
    t.record({ kind: 'content', at: T0 + MIN });
    expect(t.health(T0 + 2 * MIN)).toMatchObject({ freezeEventsPerHour: 1, contentEventsPerHour: 1 });
    expect(t.health(T0 + 2 * HOUR)).toMatchObject({ freezeEventsPerHour: 0, contentEventsPerHour: 0 });
  });

  it('disponibilité sur 24 h : temps passé en panne', () => {
    const t = new HealthTracker();
    t.record({ kind: 'up', at: T0 });
    t.record({ kind: 'down', at: T0 + 6 * HOUR });
    t.record({ kind: 'up', at: T0 + 12 * HOUR });
    // 6 h de panne sur les 24 dernières heures.
    expect(t.health(T0 + 24 * HOUR).uptime24h).toBeCloseTo(0.75, 5);
    // Panne toujours en cours : elle compte jusqu'à maintenant.
    t.record({ kind: 'down', at: T0 + 24 * HOUR });
    expect(t.health(T0 + 30 * HOUR).uptime24h).toBeCloseTo(0.5, 5);
  });

  it('une panne de contenu déclasse la source sous une source saine', () => {
    const bad = new HealthTracker();
    const good = new HealthTracker();
    for (let i = 0; i < 10; i++) {
      bad.record({ kind: 'segment', at: T0 + i, ok: true, bitrateKbps: 1300 });
      good.record({ kind: 'segment', at: T0 + i, ok: true, bitrateKbps: 1300 });
    }
    bad.record({ kind: 'content', at: T0 + 20 });
    expect(bad.health(T0 + 30).score).toBeLessThan(good.health(T0 + 30).score);
  });

  it('les événements trop anciens sont oubliés (mémoire bornée)', () => {
    const t = new HealthTracker();
    for (let i = 0; i < 5000; i++)
      t.record({ kind: 'segment', at: T0 + i * 1000, ok: true, bitrateKbps: 1000 });
    expect(t.toJSON().events.length).toBeLessThanOrEqual(DEFAULT_HEALTH_OPTIONS.maxEvents);
  });

  it('sérialisation : survit à un redémarrage (SQLite)', () => {
    const t = new HealthTracker();
    t.record({ kind: 'resolve', at: T0, ms: 250, ok: true });
    t.record({ kind: 'content', at: T0 + 1 });
    const back = HealthTracker.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(back.health(T0 + 2)).toEqual(t.health(T0 + 2));
  });

  it('données illisibles : santé repartie de zéro plutôt qu une erreur', () => {
    expect(HealthTracker.fromJSON({ nope: true }).health(T0).samples).toBe(0);
    expect(HealthTracker.fromJSON(null).health(T0).samples).toBe(0);
  });

  it('un échec de create_link compte comme un échec de segment', () => {
    const t = new HealthTracker();
    t.record({ kind: 'resolve', at: T0, ms: 5000, ok: false });
    expect(t.health(T0).segmentFailureRate).toBe(1);
  });
});

describe('classement des sources', () => {
  it('par score décroissant ; à égalité, l ordre demandé', () => {
    const ranked = rankSources([
      { id: 'a', score: 70 },
      { id: 'b', score: 90 },
      { id: 'c', score: 70 },
    ]);
    expect(ranked.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});

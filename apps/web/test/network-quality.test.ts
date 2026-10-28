import { describe, expect, it } from 'vitest';
import { DataUsage } from '../src/player/data-usage.js';
import { readNetwork } from '../src/player/network.js';
import { QualityController, capFor, PROFILE_KBPS, stepDown } from '../src/player/quality.js';

describe('réseau de l appareil', () => {
  it('WiFi, données mobiles, inconnu (API absente)', () => {
    expect(readNetwork({ type: 'wifi', effectiveType: '4g', saveData: false })).toEqual({
      kind: 'wifi',
      saveData: false,
      slow: false,
    });
    expect(readNetwork({ type: 'cellular', effectiveType: '3g', saveData: false })).toEqual({
      kind: 'cellular',
      saveData: false,
      slow: true,
    });
    expect(readNetwork(undefined)).toEqual({ kind: 'unknown', saveData: false, slow: false });
  });

  it('économie de données demandée par le système (Save-Data)', () => {
    expect(readNetwork({ effectiveType: '4g', saveData: true }).saveData).toBe(true);
  });
});

const PREFS = { wifi: 'source', cellular: 'medium', unknown: 'source', dataSaver: false } as const;

describe('plafond de qualité', () => {
  it('par réseau, selon les réglages', () => {
    expect(capFor({ kind: 'wifi', saveData: false, slow: false }, PREFS)).toBe('source');
    expect(capFor({ kind: 'cellular', saveData: false, slow: false }, PREFS)).toBe('medium');
  });

  it('économie de données (réglage ou système) : basse qualité au plus', () => {
    expect(capFor({ kind: 'wifi', saveData: false, slow: false }, { ...PREFS, dataSaver: true })).toBe('low');
    expect(capFor({ kind: 'wifi', saveData: true, slow: false }, PREFS)).toBe('low');
    // Un plafond déjà plus bas que « basse » est respecté.
    expect(capFor({ kind: 'cellular', saveData: true, slow: false }, { ...PREFS, cellular: 'audio' })).toBe(
      'audio',
    );
  });
});

const S = 1000;

describe('qualité automatique', () => {
  const fresh = () => new QualityController();

  it('débit trop juste pendant 10 s : un palier plus bas', () => {
    const c = fresh();
    const tooLow = PROFILE_KBPS.medium * 1000;
    expect(c.decide({ now: 0, bandwidthBps: tooLow, stalled: false }, 'medium', 'source')).toBe('medium');
    expect(c.decide({ now: 5 * S, bandwidthBps: tooLow, stalled: false }, 'medium', 'source')).toBe('medium');
    expect(c.decide({ now: 11 * S, bandwidthBps: tooLow, stalled: false }, 'medium', 'source')).toBe('low');
  });

  it('débit connu et bien trop faible : droit au palier qui tient, sans passer par les autres', () => {
    const c = fresh();
    const bps = 700_000;
    expect(c.decide({ now: 0, bandwidthBps: bps, stalled: false }, 'source', 'source')).toBe('source');
    expect(c.decide({ now: 11 * S, bandwidthBps: bps, stalled: false }, 'source', 'source')).toBe('low');
  });

  it('arrêt de l image et débit connu : le palier qui tient, aussitôt', () => {
    expect(fresh().decide({ now: 0, bandwidthBps: 1_500_000, stalled: true }, 'source', 'source')).toBe(
      'medium',
    );
  });

  it('arrêt de l image : un palier plus bas aussitôt', () => {
    expect(fresh().decide({ now: 0, bandwidthBps: null, stalled: true }, 'high', 'source')).toBe('medium');
  });

  it('jamais plus bas que « basse » de lui-même : l audio seul reste un choix de l utilisateur', () => {
    expect(fresh().decide({ now: 0, bandwidthBps: null, stalled: true }, 'low', 'source')).toBe('low');
    expect(stepDown('low')).toBe('audio');
  });

  it('remonte quand le débit le permet largement depuis une minute, sans arrêt récent', () => {
    const c = fresh();
    const ample = PROFILE_KBPS.medium * 1000 * 3;
    for (let t = 0; t < 60; t += 5)
      expect(c.decide({ now: t * S, bandwidthBps: ample, stalled: false }, 'low', 'source')).toBe('low');
    expect(c.decide({ now: 60 * S, bandwidthBps: ample, stalled: false }, 'low', 'source')).toBe('medium');
  });

  it('ne dépasse jamais le plafond, et y redescend aussitôt s il baisse', () => {
    const c = fresh();
    expect(c.decide({ now: 0, bandwidthBps: 1e9, stalled: false }, 'source', 'medium')).toBe('medium');
  });

  it('pas de va-et-vient : 30 s de calme après un changement', () => {
    const c = fresh();
    expect(c.decide({ now: 0, bandwidthBps: null, stalled: true }, 'high', 'source')).toBe('medium');
    expect(c.decide({ now: 5 * S, bandwidthBps: null, stalled: true }, 'medium', 'source')).toBe('medium');
    expect(c.decide({ now: 31 * S, bandwidthBps: null, stalled: true }, 'medium', 'source')).toBe('low');
  });
});

describe('compteur de consommation', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) };
  };

  it('cumule les octets du mois, repart de zéro le mois suivant', () => {
    const store = memory();
    const u = new DataUsage(store);
    u.add(500_000_000, new Date(2026, 9, 28));
    u.add(700_000_000, new Date(2026, 9, 29));
    expect(u.bytes(new Date(2026, 9, 30))).toBe(1_200_000_000);
    expect(new DataUsage(store).bytes(new Date(2026, 9, 30))).toBe(1_200_000_000);
    expect(u.bytes(new Date(2026, 10, 1))).toBe(0);
  });

  it('remise à zéro', () => {
    const u = new DataUsage(memory());
    u.add(1000, new Date(2026, 9, 28));
    u.reset();
    expect(u.bytes(new Date(2026, 9, 28))).toBe(0);
  });

  it('stockage refusé : le compteur marche en mémoire', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('refusé');
      },
      setItem: (): void => {
        throw new Error('refusé');
      },
    };
    const u = new DataUsage(broken);
    u.add(42, new Date(2026, 9, 28));
    expect(u.bytes(new Date(2026, 9, 28))).toBe(42);
  });
});

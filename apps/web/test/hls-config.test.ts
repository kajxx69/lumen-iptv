import Hls from 'hls.js';
import { describe, expect, it } from 'vitest';
import { HLS_CONFIG, HLS_CONFIG_LOW_LATENCY } from '../src/player/use-hls.js';

describe('configuration hls.js du lecteur', () => {
  // hls.js refuse certaines combinaisons dans son constructeur : le lecteur ne démarrerait jamais.
  it('confort : acceptée par hls.js', () => {
    expect(() => new Hls(HLS_CONFIG).destroy()).not.toThrow();
  });

  it('direct au plus près : acceptée, cible dans la fourchette de PROJECT.md (3–5 s)', () => {
    expect(() => new Hls(HLS_CONFIG_LOW_LATENCY).destroy()).not.toThrow();
    expect(HLS_CONFIG_LOW_LATENCY.liveSyncDuration).toBeGreaterThanOrEqual(3);
    expect(HLS_CONFIG_LOW_LATENCY.liveSyncDuration).toBeLessThanOrEqual(5);
    expect(HLS_CONFIG_LOW_LATENCY.lowLatencyMode).toBe(true);
  });
});

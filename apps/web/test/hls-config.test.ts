import Hls from 'hls.js';
import { describe, expect, it } from 'vitest';
import { HLS_CONFIG } from '../src/player/use-hls.js';

describe('configuration hls.js du lecteur', () => {
  // hls.js refuse certaines combinaisons dans son constructeur : le lecteur ne démarrerait jamais.
  it('est acceptée par hls.js', () => {
    expect(() => new Hls(HLS_CONFIG).destroy()).not.toThrow();
  });
});

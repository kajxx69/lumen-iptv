import { describe, expect, it } from 'vitest';
import { capabilitiesFrom } from '../src/player/capabilities.js';

const none = (): boolean => false;
const all = (): boolean => true;

describe('capacités du navigateur transmises au serveur', () => {
  it('hls.js : ce que MSE décode, jamais l E-AC-3 (non démultiplexé en TS)', () => {
    expect(capabilitiesFrom({ hlsJs: true, mse: all, native: none })).toEqual({
      hevc: true,
      ac3: true,
      eac3: false,
    });
    expect(capabilitiesFrom({ hlsJs: true, mse: none, native: all })).toEqual({
      hevc: false,
      ac3: false,
      eac3: false,
    });
  });

  it('HLS natif (Safari) : ce que la balise vidéo sait lire', () => {
    expect(
      capabilitiesFrom({ hlsJs: false, mse: none, native: (t) => t.includes('hvc1') || t.includes('ec-3') }),
    ).toEqual({ hevc: true, ac3: false, eac3: true });
  });
});

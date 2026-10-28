import type { ClientCapabilities } from '@lumen/protocol';

/** Types testés : profil HEVC Main courant, AC-3 et E-AC-3 tels que hls.js les annonce à MSE. */
const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
const AC3_TYPE = 'audio/mp4; codecs="ac-3"';
const EAC3_TYPE = 'audio/mp4; codecs="ec-3"';

export interface CapabilityProbes {
  /** Lecture par hls.js (MSE) ; sinon HLS natif (Safari, iOS). */
  hlsJs: boolean;
  /** MediaSource.isTypeSupported. */
  mse: (type: string) => boolean;
  /** HTMLMediaElement.canPlayType, pour le HLS natif. */
  native: (type: string) => boolean;
}

/**
 * Ce que ce navigateur décode au-delà du socle H.264 + AAC : le serveur ne transcode que le
 * reste (PROJECT.md §8). hls.js ne démultiplexe pas l'E-AC-3 dans du MPEG-TS : jamais annoncé.
 */
export function capabilitiesFrom(p: CapabilityProbes): ClientCapabilities {
  if (p.hlsJs) return { hevc: p.mse(HEVC_TYPE), ac3: p.mse(AC3_TYPE), eac3: false };
  return { hevc: p.native(HEVC_TYPE), ac3: p.native(AC3_TYPE), eac3: p.native(EAC3_TYPE) };
}

const safely =
  (probe: (type: string) => boolean) =>
  (type: string): boolean => {
    try {
      return probe(type);
    } catch {
      return false;
    }
  };

export function detectCapabilities(hlsJs: boolean): ClientCapabilities {
  const video = document.createElement('video');
  return capabilitiesFrom({
    hlsJs,
    mse: safely((type) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type)),
    native: safely((type) => video.canPlayType(type) !== ''),
  });
}

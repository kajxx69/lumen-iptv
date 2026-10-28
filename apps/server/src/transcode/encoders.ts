import { spawn } from 'node:child_process';

/** Encodeur H.264 retenu pour les transcodages de ce serveur. */
export interface EncoderChoice {
  encoder: string;
  /** Accélération matérielle : sinon, le processeur fait tout (coûteux, voir PROJECT.md §8). */
  hardware: boolean;
}

export const SOFTWARE_ENCODER: EncoderChoice = { encoder: 'libx264', hardware: false };

/**
 * Encodeurs matériels essayés, du plus courant au plus rare : NVIDIA, Intel Quick Sync,
 * AMD, VAAPI (Linux), VideoToolbox (macOS). Le premier qui encode vraiment est retenu :
 * qu'il soit compilé dans FFmpeg ne prouve pas qu'un GPU et son pilote sont là.
 */
export const HARDWARE_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'h264_videotoolbox'];

/** `auto` : détection ; `software` : libx264 imposé ; sinon le nom d'un encodeur précis. */
export type EncoderPreference = string;

const VAAPI_DEVICE = '/dev/dri/renderD128';
/** Essai : 10 images minuscules, de quoi ouvrir l'encodeur sans coûter. */
const PROBE_INPUT = 'color=c=black:s=256x144:r=25:d=0.4';
const PROBE_TIMEOUT_MS = 10_000;

export function probeArgs(encoder: string): string[] {
  const vaapi = encoder === 'h264_vaapi';
  // prettier-ignore
  return [
    '-hide_banner', '-loglevel', 'error',
    ...(vaapi ? ['-vaapi_device', VAAPI_DEVICE] : []),
    '-f', 'lavfi', '-i', PROBE_INPUT,
    ...(vaapi ? ['-vf', 'format=nv12,hwupload'] : []),
    '-c:v', encoder, '-f', 'null', '-',
  ];
}

/** L'encodeur fonctionne-t-il sur cette machine (encodage d'essai réussi) ? */
export function probeEncoder(ffmpegPath: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, probeArgs(encoder), { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function detectEncoder(
  preference: EncoderPreference,
  probe: (encoder: string) => Promise<boolean>,
): Promise<EncoderChoice> {
  if (preference === 'software') return SOFTWARE_ENCODER;
  const candidates = preference === 'auto' ? HARDWARE_ENCODERS : [preference];
  for (const encoder of candidates) {
    if (await probe(encoder)) return { encoder, hardware: encoder !== SOFTWARE_ENCODER.encoder };
  }
  return SOFTWARE_ENCODER;
}

import type { EncoderChoice } from './encoders.js';
import type { OutputPlan } from './plan.js';

export interface TranscodeOptions {
  /** Image clé forcée à ce rythme : les segments du relais tombent sur des images clés. */
  keyframeIntervalS: number;
  /** Hauteur maximale de l'image transcodée : au-delà, réduite (débit et calcul maîtrisés). */
  maxHeight: number;
  audioBitrateKbps: number;
}

const VAAPI_DEVICE = '/dev/dri/renderD128';
/** Débit plafond du H.264 produit en logiciel : une 720p nette, sans saturer un lien modeste. */
const SOFTWARE_MAX_RATE_KBPS = 3000;

/** Réglages propres à chaque encodeur : faible latence, qualité constante raisonnable. */
function encoderTuning(encoder: string): string[] {
  switch (encoder) {
    case 'libx264':
      // prettier-ignore
      return [
        '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23',
        '-maxrate', `${SOFTWARE_MAX_RATE_KBPS}k`, '-bufsize', `${2 * SOFTWARE_MAX_RATE_KBPS}k`,
      ];
    case 'h264_nvenc':
      return ['-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '23'];
    case 'h264_qsv':
      return ['-preset', 'veryfast', '-global_quality', '25'];
    case 'h264_amf':
      return ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'];
    case 'h264_videotoolbox':
      return ['-realtime', '1', '-b:v', `${SOFTWARE_MAX_RATE_KBPS}k`];
    default:
      return [];
  }
}

function videoArgs(plan: OutputPlan, enc: EncoderChoice, o: TranscodeOptions): string[] {
  if (plan.video === 'copy') return ['-c:v', 'copy'];
  const keyframes = ['-force_key_frames', `expr:gte(t,n_forced*${o.keyframeIntervalS})`];
  if (enc.encoder === 'h264_vaapi') {
    // Décodage logiciel, mise à l'échelle et encodage sur le GPU.
    // prettier-ignore
    return [
      '-vf', `format=nv12,hwupload,scale_vaapi=w=-2:h='min(${o.maxHeight},ih)'`,
      '-c:v', 'h264_vaapi', ...keyframes,
    ];
  }
  // prettier-ignore
  return [
    '-vf', `scale=-2:'min(${o.maxHeight},ih)'`,
    '-c:v', enc.encoder, ...encoderTuning(enc.encoder),
    // Quick Sync attend du NV12 ; les autres, du YUV 4:2:0 planaire (profil lu partout).
    '-pix_fmt', enc.encoder === 'h264_qsv' ? 'nv12' : 'yuv420p',
    ...keyframes,
  ];
}

function audioArgs(plan: OutputPlan, o: TranscodeOptions): string[] {
  return plan.audio === 'copy'
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', `${o.audioBitrateKbps}k`, '-ac', '2'];
}

/**
 * FFmpeg en filtre : MPEG-TS du relais sur l'entrée standard, MPEG-TS lisible par le
 * navigateur sur la sortie standard, découpé ensuite comme n'importe quelle source.
 */
export function transcodeArgs(plan: OutputPlan, enc: EncoderChoice, o: TranscodeOptions): string[] {
  // prettier-ignore
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(plan.video === 'h264' && enc.encoder === 'h264_vaapi' ? ['-vaapi_device', VAAPI_DEVICE] : []),
    // Horodatages refaits si l'amont en manque, paquets abîmés écartés plutôt que fatals.
    '-fflags', '+genpts+discardcorrupt', '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0?', '-map', '0:a:0?',
    ...videoArgs(plan, enc, o),
    ...audioArgs(plan, o),
    '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1',
  ];
}

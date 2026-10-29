import type { EncoderChoice } from './encoders.js';
import type { OutputPlan } from './plan.js';

export interface TranscodeOptions {
  /** Hauteur maximale de l'image transcodée : au-delà, réduite (débit et calcul maîtrisés). */
  maxHeight: number;
  audioBitrateKbps: number;
}

const VAAPI_DEVICE = '/dev/dri/renderD128';
const MUX_DELAY_S = 0.2;
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

/** Filtres de l'image convertie : cadence (audio seul), puis mise à l'échelle (sur le GPU en VAAPI). */
function videoChain(plan: OutputPlan, enc: EncoderChoice, o: TranscodeOptions): string {
  const step = plan.ladder;
  const height = step?.height ?? o.maxHeight;
  const fps = step?.fps == null ? '' : `fps=${step.fps},`;
  // Décodage logiciel, mise à l'échelle et encodage sur le GPU.
  if (enc.encoder === 'h264_vaapi')
    return `${fps}format=nv12,hwupload,scale_vaapi=w=-2:h='min(${height},ih)'`;
  return `${fps}scale=-2:'min(${height},ih)'`;
}

/** Encodeur et ses réglages, sans les filtres. */
function videoEncoder(plan: OutputPlan, enc: EncoderChoice): string[] {
  // Images clés aux mêmes instants que la source : les segments de la sortie convertie tombent
  // exactement sur ceux de la sortie directe, une vue de session passe de l'une à l'autre sans
  // rien sauter. Image quasi fixe (audio seul) : chaque image est une image clé.
  const keyframes = plan.ladder?.fps == null ? ['-force_key_frames', 'source'] : ['-g', '1'];
  const step = plan.ladder;
  // Palier réduit : débit plafonné, et images espacées pour l'audio seul.
  const rate =
    step === undefined
      ? []
      : [
          '-b:v',
          `${step.videoKbps}k`,
          '-maxrate',
          `${step.videoKbps}k`,
          '-bufsize',
          `${2 * step.videoKbps}k`,
        ];
  if (enc.encoder === 'h264_vaapi') return ['-c:v', 'h264_vaapi', ...rate, ...keyframes];
  // prettier-ignore
  return [
    '-c:v', enc.encoder, ...(step === undefined ? encoderTuning(enc.encoder) : [...speedTuning(enc.encoder), ...rate]),
    // Quick Sync attend du NV12 ; les autres, du YUV 4:2:0 planaire (profil lu partout).
    '-pix_fmt', enc.encoder === 'h264_qsv' ? 'nv12' : 'yuv420p',
    ...keyframes,
  ];
}

function videoArgs(plan: OutputPlan, enc: EncoderChoice, o: TranscodeOptions): string[] {
  if (plan.video === 'copy') return ['-c:v', 'copy'];
  return ['-vf', videoChain(plan, enc, o), ...videoEncoder(plan, enc)];
}

function audioArgs(plan: OutputPlan, o: TranscodeOptions): string[] {
  if (plan.audio === 'copy') return ['-c:a', 'copy'];
  const kbps = plan.ladder?.audioKbps ?? o.audioBitrateKbps;
  return ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ac', '2'];
}

/** Réglages de vitesse seuls, sans contrôle de qualité : le palier impose son débit. */
function speedTuning(encoder: string): string[] {
  switch (encoder) {
    case 'libx264':
      return ['-preset', 'veryfast', '-tune', 'zerolatency'];
    case 'h264_nvenc':
      return ['-preset', 'p4', '-tune', 'll'];
    case 'h264_qsv':
      return ['-preset', 'veryfast'];
    case 'h264_amf':
      return ['-quality', 'speed'];
    default:
      return [];
  }
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
    // Horodatages de l'amont conservés : une vue de session passe d'une sortie à l'autre à l'image près.
    '-copyts',
    '-map', '0:v:0?', '-map', '0:a:0?',
    ...videoArgs(plan, enc, o),
    ...audioArgs(plan, o),
    // 200 ms pour regrouper les trames audio dans un même paquet : sans cela, chaque trame AAC
    // occupe deux paquets TS presque vides, et l'emballage double le débit d'un flux léger.
    // Le délai ne touche que l'horloge du multiplexeur (PCR), pas les horodatages des images.
    '-f', 'mpegts', '-muxdelay', String(MUX_DELAY_S), '-muxpreload', '0', 'pipe:1',
  ];
}

/** Film ou épisode à lire : l'adresse du relais local, la position de départ, la piste audio. */
export interface VodInput {
  url: string;
  startS: number;
  audioIndex: number;
  /** Lecture du début du fichier pour y trouver les pistes (voir probe.ts). */
  analysisArgs: readonly string[];
  /** Pistes de sous-titres texte extraites en WebVTT, chacune sur sa sortie (`pipe:3`, `pipe:4`…). */
  textSubtitles: readonly number[];
  /** Piste de sous-titres en images incrustée dans l'image (qui est alors convertie) ; null : aucune. */
  burnSubtitle: number | null;
}

/** Première sortie des sous-titres texte : 0, 1 et 2 sont l'entrée, la vidéo et les messages. */
export const FIRST_SUBTITLE_FD = 3;

/**
 * FFmpeg lit le fichier d'un film (par le relais local) à partir de `startS` et produit du
 * MPEG-TS lisible par le navigateur : flux copiés autant que possible, convertis sinon. Les
 * sous-titres texte sortent à part, en WebVTT, au rythme de la lecture du fichier.
 */
export function vodArgs(
  input: VodInput,
  plan: OutputPlan,
  enc: EncoderChoice,
  o: TranscodeOptions,
): string[] {
  const burn = input.burnSubtitle !== null && plan.video === 'h264';
  const video = burn
    ? [
        // Sous-titres en images posés sur l'image avant sa mise à l'échelle.
        '-filter_complex',
        `[0:V:0][0:s:${input.burnSubtitle}]overlay,${videoChain(plan, enc, o)}[v]`,
        '-map',
        '[v]',
      ]
    : ['-map', '0:V:0?'];
  // prettier-ignore
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(plan.video === 'h264' && enc.encoder === 'h264_vaapi' ? ['-vaapi_device', VAAPI_DEVICE] : []),
    // Recherche avant lecture : FFmpeg part de l'image clé qui précède la position voulue.
    ...(input.startS > 0 ? ['-ss', input.startS.toFixed(3)] : []),
    '-fflags', '+genpts+discardcorrupt', ...input.analysisArgs, '-i', input.url,
    // Horodatages du fichier conservés : chaque segment et chaque réplique savent où ils se
    // placent dans le film.
    '-copyts',
    // « V » : la vidéo du film, jamais une pochette intégrée au fichier.
    ...video, '-map', `0:a:${input.audioIndex}?`, '-sn', '-dn',
    ...(burn ? videoEncoder(plan, enc) : videoArgs(plan, enc, o)),
    ...audioArgs(plan, o),
    '-f', 'mpegts', '-muxdelay', String(MUX_DELAY_S), '-muxpreload', '0', 'pipe:1',
    ...input.textSubtitles.flatMap((index, k) => [
      '-map', `0:s:${index}`, '-c:s', 'webvtt', '-f', 'webvtt', '-flush_packets', '1',
      `pipe:${FIRST_SUBTITLE_FD + k}`,
    ]),
  ];
}

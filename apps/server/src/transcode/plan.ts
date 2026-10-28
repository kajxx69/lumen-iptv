import type { ClientCapabilities, QualityProfile } from '@lumen/protocol';
import type { AudioCodec, VideoCodec } from '../relay/mpegts.js';

/**
 * Que faire du flux amont pour un navigateur donné (PROJECT.md §8) : le copier tel quel
 * dès qu'il sait le lire, ne transcoder que ce qui l'exige. Convertir l'audio AC-3 en AAC
 * coûte peu ; transcoder la vidéo coûte cher.
 */
export type VideoAction = 'copy' | 'h264';
export type AudioAction = 'copy' | 'aac';

/** Un palier de qualité réduite : la vidéo est réencodée à cette taille et à ce débit. */
export interface QualityStep {
  height: number;
  videoKbps: number;
  /** Débit du son converti en AAC ; null : le son garde sa qualité (copié si possible). */
  audioKbps: number | null;
  /** Images par seconde imposées ; null : celles de la source. */
  fps: number | null;
}

/**
 * Échelle de qualités (PROJECT.md, adaptation au réseau). Débits usuels d'un flux H.264 en
 * direct : 720p net sur un téléviseur, 480p confortable sur téléphone, 360p pour un réseau
 * mobile faible. « audio » garde une vignette à une image par seconde : la piste vidéo
 * subsiste (le lecteur ne change jamais de type de flux), pour presque aucun octet.
 */
export const QUALITY_LADDER: Record<Exclude<QualityProfile, 'source'>, QualityStep> = {
  high: { height: 720, videoKbps: 2500, audioKbps: null, fps: null },
  medium: { height: 480, videoKbps: 1000, audioKbps: null, fps: null },
  low: { height: 360, videoKbps: 500, audioKbps: 64, fps: null },
  audio: { height: 144, videoKbps: 16, audioKbps: 64, fps: 1 },
};

export interface OutputPlan {
  video: VideoAction;
  audio: AudioAction;
  /** Identifie la sortie : deux spectateurs de même plan partagent le même transcodage. */
  key: string;
  /** Palier de qualité réduite ; absent : qualité de la source. */
  ladder?: QualityStep;
}

const plan = (video: VideoAction, audio: AudioAction): OutputPlan => ({
  video,
  audio,
  key: `${video}+${audio}`,
});

export const PASSTHROUGH: OutputPlan = plan('copy', 'copy');

export interface StreamCodecs {
  videoCodec: VideoCodec | null;
  audioCodec: AudioCodec | null;
}

function videoAction(codec: VideoCodec | null, caps: ClientCapabilities): VideoAction {
  switch (codec) {
    case null:
    case 'h264':
      return 'copy';
    case 'hevc':
      return caps.hevc ? 'copy' : 'h264';
    // MPEG-2 : aucun navigateur ; codecs rares : on ne parie pas.
    case 'mpeg2':
    case 'other':
      return 'h264';
  }
}

function audioAction(codec: AudioCodec | null, caps: ClientCapabilities): AudioAction {
  switch (codec) {
    case null:
    case 'aac':
    case 'mp3':
      return 'copy';
    case 'ac3':
      return caps.ac3 ? 'copy' : 'aac';
    case 'eac3':
      return caps.eac3 ? 'copy' : 'aac';
    case 'other':
      return 'aac';
  }
}

export function planOutput(
  codecs: StreamCodecs,
  caps: ClientCapabilities,
  quality: QualityProfile = 'source',
): OutputPlan {
  const audio = audioAction(codecs.audioCodec, caps);
  if (quality === 'source' || codecs.videoCodec === null)
    return plan(videoAction(codecs.videoCodec, caps), audio);
  const ladder = QUALITY_LADDER[quality];
  const reducedAudio = ladder.audioKbps === null ? audio : 'aac';
  return { video: 'h264', audio: reducedAudio, key: `h264+${reducedAudio}@${quality}`, ladder };
}

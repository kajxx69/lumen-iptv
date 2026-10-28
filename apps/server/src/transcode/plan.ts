import type { ClientCapabilities } from '@lumen/protocol';
import type { AudioCodec, VideoCodec } from '../relay/mpegts.js';

/**
 * Que faire du flux amont pour un navigateur donné (PROJECT.md §8) : le copier tel quel
 * dès qu'il sait le lire, ne transcoder que ce qui l'exige. Convertir l'audio AC-3 en AAC
 * coûte peu ; transcoder la vidéo coûte cher.
 */
export type VideoAction = 'copy' | 'h264';
export type AudioAction = 'copy' | 'aac';

export interface OutputPlan {
  video: VideoAction;
  audio: AudioAction;
  /** Identifie la sortie : deux spectateurs de même plan partagent le même transcodage. */
  key: string;
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

export function planOutput(codecs: StreamCodecs, caps: ClientCapabilities): OutputPlan {
  return plan(videoAction(codecs.videoCodec, caps), audioAction(codecs.audioCodec, caps));
}

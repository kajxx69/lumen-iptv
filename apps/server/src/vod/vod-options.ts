import { type ServerConfig, ffprobePathOf } from '../config.js';
import type { VodPlaybackOptions } from './vod-service.js';

/** Premier segment court : l'image apparaît vite, le reste suit à la durée visée. */
const FIRST_SEGMENT_TARGET_S = 1;
/** Démarrage rapide (coupes sans attendre l'image clé) pendant les premières secondes du film. */
const FAST_START_S = 2;
/** Fichier sans image clé assez fréquente : coupe forcée à ce multiple de la durée visée. */
const FORCE_CUT_TARGETS = 2;
/** Un écart d'horodatage au-delà est une rupture dans le fichier, pas l'image suivante. */
const TIMESTAMP_JUMP_S = 5;
/** Un morceau de segment plus court (fin de fichier) ne vaut pas une requête de plus. */
const MIN_FLUSH_DURATION_S = 0.5;

export function vodPlaybackOptions(config: ServerConfig): VodPlaybackOptions {
  const target = config.vodSegmentTargetS;
  return {
    ffmpegPath: config.ffmpegPath,
    ffprobePath: ffprobePathOf(config),
    maxSessions: config.vodMaxSessions,
    maxSessionsPerUser: config.maxStreamsPerUser,
    idleTtlMs: config.playbackIdleTtlMs,
    probeTimeoutMs: config.vodProbeTimeoutMs,
    startTimeoutMs: config.vodStartTimeoutMs,
    segmenter: {
      targetDurationS: target,
      firstTargetDurationS: Math.min(FIRST_SEGMENT_TARGET_S, target),
      fastStartS: FAST_START_S,
      forceCutDurationS: FORCE_CUT_TARGETS * target,
      timestampJumpS: TIMESTAMP_JUMP_S,
      minFlushDurationS: MIN_FLUSH_DURATION_S,
      partTargetS: 0,
    },
    segments: { aheadS: config.vodAheadS, behindS: config.vodBehindS, targetDurationS: target },
    transcode: { maxHeight: config.transcodeMaxHeight, audioBitrateKbps: config.transcodeAudioBitrateKbps },
  };
}

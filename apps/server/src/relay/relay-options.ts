import type { ServerConfig } from '../config.js';
import type { RelayManagerOptions } from './relay-manager.js';

/** La coupure forcée reste sous EXT-X-TARGETDURATION, image en cours comprise. */
const FORCE_CUT_MARGIN_S = 0.5;
/**
 * Un écart d'horodatage au-delà est une rupture du flux (reprise d'encodeur, boucle),
 * pas une image suivante : le plus long saut légitime entre deux images est bien plus court.
 */
const TIMESTAMP_JUMP_S = 5;
/** Un morceau de segment plus court ne vaut pas une requête de plus pour le lecteur. */
const MIN_FLUSH_DURATION_S = 0.5;
/** ≈ 6 s de tampon immédiat à l'ouverture d'une source HLS (segments amont de 2 s). */
const HLS_INITIAL_BACKLOG_SEGMENTS = 3;
/** ±20 % : assez pour désynchroniser des relais tombés ensemble, sans changer l'ordre de grandeur. */
const RETRY_JITTER_RATIO = 0.2;

export function relayManagerOptions(config: ServerConfig): RelayManagerOptions {
  return {
    lingerMs: config.relayLingerMs,
    segmentCacheBytes: config.relaySegmentCacheBytes,
    relay: {
      bufferS: config.relayBufferS,
      targetDurationS: config.relayTargetDurationS,
      stallTimeoutMs: config.relayStallTimeoutMs,
      segmenter: {
        targetDurationS: config.relaySegmentTargetS,
        firstTargetDurationS: Math.min(config.relayFirstSegmentTargetS, config.relaySegmentTargetS),
        forceCutDurationS: config.relayTargetDurationS - FORCE_CUT_MARGIN_S,
        timestampJumpS: TIMESTAMP_JUMP_S,
        minFlushDurationS: MIN_FLUSH_DURATION_S,
      },
      upstream: {
        connectTimeoutMs: config.upstreamTimeoutMs,
        hlsSegmentRetryDeadlineMs: config.hlsSegmentRetryDeadlineMs,
        hlsInitialBacklogSegments: HLS_INITIAL_BACKLOG_SEGMENTS,
      },
      failover: {
        initialDelayMs: config.relayRetryInitialDelayMs,
        maxDelayMs: config.relayRetryMaxDelayMs,
        bufferedMaxDelayMs: config.relayRetryBufferedMaxDelayMs,
        jitterRatio: RETRY_JITTER_RATIO,
      },
    },
  };
}

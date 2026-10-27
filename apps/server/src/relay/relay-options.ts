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
/**
 * Source trop lente : moins de 40 % du débit du flux sur 4 s. Une source HLS livre par
 * à-coups (un segment de 2 s d'un bloc) : 4 s en contiennent toujours au moins un, et 40 %
 * laisse passer ces à-coups tout en repérant un débit divisé par 3 ou plus.
 */
const SLOW_RATIO = 0.4;
const SLOW_WINDOW_MS = 4000;
/**
 * Retard visé sur le direct, annoncé aux lecteurs (HOLD-BACK) : celui du lecteur web
 * (20 s, de quoi couvrir une coupure de 15 s). La RFC impose au moins trois durées cibles.
 */
const LIVE_HOLD_BACK_S = 20;
const MIN_HOLD_BACK_TARGETS = 3;

export function relayManagerOptions(config: ServerConfig): RelayManagerOptions {
  return {
    lingerMs: config.relayLingerMs,
    segmentCacheBytes: config.relaySegmentCacheBytes,
    relay: {
      bufferS: config.relayBufferS,
      targetDurationS: config.relayTargetDurationS,
      holdBackS: Math.max(LIVE_HOLD_BACK_S, MIN_HOLD_BACK_TARGETS * config.relayTargetDurationS),
      stallTimeoutMs: config.relayStallTimeoutMs,
      detection: {
        freezeMs: config.freezeDetectionMs,
        contentFailureS: config.contentFailureS,
        slowRatio: SLOW_RATIO,
        slowWindowMs: SLOW_WINDOW_MS,
      },
      segmenter: {
        targetDurationS: config.relaySegmentTargetS,
        firstTargetDurationS: Math.min(config.relayFirstSegmentTargetS, config.relaySegmentTargetS),
        forceCutDurationS: config.relayTargetDurationS - FORCE_CUT_MARGIN_S,
        timestampJumpS: TIMESTAMP_JUMP_S,
        minFlushDurationS: MIN_FLUSH_DURATION_S,
        fastStartS: config.relayFastStartS,
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

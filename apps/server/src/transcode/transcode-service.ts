import type { ClientCapabilities, QualityProfile } from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../http/errors.js';
import type { Relay } from '../relay/relay.js';
import type { SegmentCache } from '../relay/segment-cache.js';
import { type EncoderChoice, type EncoderPreference, detectEncoder, probeEncoder } from './encoders.js';
import type { TranscodeOptions } from './ffmpeg-args.js';
import { planOutput } from './plan.js';
import { TranscodedOutput } from './transcoded-output.js';

export interface TranscodeServiceOptions {
  ffmpegPath: string;
  encoder: EncoderPreference;
  /** Transcodages vidéo simultanés au plus (la conversion audio seule ne compte pas : elle ne coûte presque rien). */
  maxVideo: number;
  transcode: TranscodeOptions;
}

/**
 * Transcodages du serveur : choix de l'encodeur au démarrage (matériel si possible), partage
 * d'une sortie transcodée entre les spectateurs d'un même relais, plafond de charge.
 */
export class TranscodeService {
  private readonly encoder: Promise<EncoderChoice>;
  private known: EncoderChoice | null = null;
  private activeVideo = 0;
  private active = 0;

  constructor(
    private readonly options: TranscodeServiceOptions,
    private readonly cache: SegmentCache,
    private readonly log: FastifyBaseLogger,
  ) {
    this.encoder = detectEncoder(options.encoder, (e) => probeEncoder(options.ffmpegPath, e)).then(
      (choice) => {
        this.known = choice;
        if (choice.hardware)
          log.info({ encoder: choice.encoder }, 'transcodage vidéo accéléré par le matériel');
        else {
          log.warn(
            { encoder: choice.encoder },
            'aucun encodeur matériel utilisable : transcodage vidéo par le processeur (coûteux, image réduite)',
          );
        }
        return choice;
      },
    );
  }

  /** Sorties transcodées en cours, et parmi elles celles qui réencodent la vidéo (métriques). */
  get activeCount(): { all: number; video: number } {
    return { all: this.active, video: this.activeVideo };
  }

  /** Encodeur retenu, null tant que la détection n'a pas fini. */
  get encoderChoice(): EncoderChoice | null {
    return this.known;
  }

  /**
   * Sortie transcodée de ce relais pour ces capacités : partagée si elle existe, créée sinon.
   * Le plafond vidéo est jugé sur la source en cours.
   */
  async acquire(
    relay: Relay,
    caps: ClientCapabilities,
    quality: QualityProfile = 'source',
  ): Promise<TranscodedOutput> {
    const encoder = await this.encoder;
    const key = `${capabilitiesKey(caps)}@${quality}`;
    let output = relay.transcoded(key);
    if (output === undefined) {
      const streams = relay.programStreams;
      const video = streams !== null && planOutput(streams, caps, quality).video !== 'copy';
      if (video && this.activeVideo >= this.options.maxVideo) {
        throw new ApiError(
          503,
          'transcode_busy',
          'le serveur convertit déjà le maximum de chaînes à la fois ; réessayez dans un moment',
        );
      }
      const created = new TranscodedOutput(
        caps,
        quality,
        key,
        `${relay.id}:${key}`,
        relay.mediaOptions,
        this.cache,
        () => relay.currentSourceId,
        { ffmpegPath: this.options.ffmpegPath, encoder, options: this.options.transcode, log: this.log },
      );
      this.active++;
      if (video) this.activeVideo++;
      created.onClose = () => {
        this.active--;
        if (video) this.activeVideo--;
      };
      relay.attachTranscoded(created);
      output = created;
    }
    output.viewers++;
    return output;
  }

  release(relay: Relay, output: TranscodedOutput): void {
    output.viewers = Math.max(0, output.viewers - 1);
    if (output.viewers > 0) return;
    relay.detachTranscoded(output.key);
    output.close();
  }
}

/** Deux spectateurs aux mêmes capacités partagent la même sortie transcodée. */
export const capabilitiesKey = (caps: ClientCapabilities): string =>
  `caps:${caps.hevc ? 'hevc' : '-'}${caps.ac3 ? '+ac3' : ''}${caps.eac3 ? '+eac3' : ''}`;

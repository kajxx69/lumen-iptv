import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ClientCapabilities, QualityProfile } from '@lumen/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { MediaOutput, type MediaOutputOptions } from '../relay/media-output.js';
import type { ProgramStreams } from '../relay/mpegts.js';
import type { SegmentCache } from '../relay/segment-cache.js';
import type { EncoderChoice } from './encoders.js';
import { type TranscodeOptions, transcodeArgs } from './ffmpeg-args.js';
import { type OutputPlan, planOutput } from './plan.js';

/**
 * Données en attente vers FFmpeg au-delà desquelles il ne tient plus le direct (processeur
 * saturé) : on le relance plutôt que d'accumuler un retard et de la mémoire sans fin.
 * ≈ 25 s d'un flux SD à 1,3 Mbit/s.
 */
const MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;
/** Relance après un arrêt inattendu de FFmpeg : 1 s, 2 s, 4 s… jusqu'à 10 s. */
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 10_000;
/** Lignes d'erreur de FFmpeg gardées : de quoi comprendre un échec, sans gonfler la mémoire. */
const STDERR_KEPT_CHARS = 2000;

export interface TranscoderDeps {
  ffmpegPath: string;
  encoder: EncoderChoice;
  options: TranscodeOptions;
  log: FastifyBaseLogger;
}

type Ffmpeg = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Une sortie transcodée d'un relais (PROJECT.md §8) : FFmpeg reçoit le flux amont et rend un
 * MPEG-TS que ce navigateur sait lire, découpé comme la sortie directe. Partagée par tous les
 * spectateurs aux mêmes capacités. Une bascule de source la relance (discontinuité), avec le
 * plan qui convient à la nouvelle source : ses codecs peuvent différer de ceux de la première.
 */
export class TranscodedOutput {
  readonly output: MediaOutput;
  viewers = 0;
  /** Plan de la source en cours ; null le temps de connaître ses codecs. */
  plan: OutputPlan | null = null;
  /** Appelé une fois, à la fermeture (fin de la charge de transcodage). */
  onClose: () => void = () => undefined;
  private child: Ffmpeg | null = null;
  private closed = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private published = 0;
  private readyWaiters: (() => void)[] = [];
  /** Octets reçus en attendant les codecs de la nouvelle source (sa PMT) ; null hors attente. */
  private waiting: Buffer[] | null = null;
  private waitingBytes = 0;
  private readonly log: FastifyBaseLogger;

  constructor(
    readonly caps: ClientCapabilities,
    readonly quality: QualityProfile,
    /** Identifie la sortie dans son relais : une par jeu de capacités et par qualité. */
    readonly key: string,
    cacheKey: string,
    mediaOptions: MediaOutputOptions,
    cache: SegmentCache,
    sourceId: () => string,
    private readonly deps: TranscoderDeps,
  ) {
    this.log = deps.log.child({ transcode: key, encoder: deps.encoder.encoder });
    this.output = new MediaOutput(cacheKey, mediaOptions, cache, sourceId, () => {
      this.published++;
      this.failures = 0;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w();
    });
  }

  /** Démarre FFmpeg, amorcé avec le flux récent du relais, dès que ses codecs sont connus. */
  start(seed: readonly Buffer[], streams: ProgramStreams | null): void {
    this.waiting = [...seed];
    this.waitingBytes = seed.reduce((n, b) => n + b.length, 0);
    if (streams !== null) this.planAndSpawn(streams);
  }

  private planAndSpawn(streams: ProgramStreams): void {
    this.plan = planOutput(streams, this.caps, this.quality);
    const seed = this.waiting ?? [];
    this.waiting = null;
    this.waitingBytes = 0;
    this.spawn(seed);
  }

  private spawn(seed: readonly Buffer[]): void {
    const plan = this.plan;
    if (this.closed || plan === null) return;
    const child = spawn(this.deps.ffmpegPath, transcodeArgs(plan, this.deps.encoder, this.deps.options), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT_CHARS);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.output.push(chunk);
    });
    // Écritures vers un FFmpeg qui s'arrête : sans conséquence, il sera relancé.
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      this.log.error({ err: err.message }, 'transcodage impossible à lancer');
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.closed) return;
      this.failures++;
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.failures - 1));
      this.log.warn(
        { code, delayMs: delay, stderr: stderr.trim().split('\n').slice(-3) },
        'transcodage arrêté, relance',
      );
      this.output.breakStream();
      this.restartTimer = setTimeout(() => {
        this.spawn([]);
      }, delay);
    });
    for (const chunk of seed) child.stdin.write(chunk);
    this.log.info(
      { plan: plan.key, seedBytes: seed.reduce((n, b) => n + b.length, 0) },
      'transcodage démarré',
    );
  }

  /** Octets amont, au fil de l'eau, avec les codecs de la source en cours s'ils sont connus. */
  write(bytes: Uint8Array, streams: ProgramStreams | null): void {
    if (this.closed) return;
    if (this.waiting !== null) {
      // Nouvelle source : ses premiers octets attendent la connaissance de ses codecs.
      if (this.waitingBytes + bytes.length <= MAX_PENDING_INPUT_BYTES) {
        this.waiting.push(Buffer.from(bytes));
        this.waitingBytes += bytes.length;
      }
      if (streams !== null) this.planAndSpawn(streams);
      return;
    }
    const child = this.child;
    if (child === null) return;
    if (child.stdin.writableLength > MAX_PENDING_INPUT_BYTES) {
      this.log.warn('transcodage en retard sur le direct : relance');
      // L'arrêt déclenche la relance (voir « close »), avec une discontinuité.
      child.kill('SIGKILL');
      return;
    }
    child.stdin.write(bytes);
  }

  /**
   * Nouvelle source (ou rupture du flux) : FFmpeg repart de zéro, avec le plan qui convient à
   * la nouvelle source, dès que ses codecs sont connus. La suite porte une discontinuité.
   */
  restart(): void {
    if (this.closed) return;
    const child = this.child;
    this.child = null;
    child?.kill('SIGKILL');
    clearTimeout(this.restartTimer);
    this.output.breakStream();
    this.waiting = [];
    this.waitingBytes = 0;
  }

  /** Résolu au premier segment transcodé, ou à l'échéance (rejet). */
  ready(timeoutMs: number): Promise<void> {
    if (this.published > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('aucun segment transcodé dans le délai de démarrage'));
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.child?.kill('SIGKILL');
    this.child = null;
    this.output.close();
    this.onClose();
    this.log.info({ segments: this.published }, 'transcodage arrêté');
  }
}

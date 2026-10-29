import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { type Cue, WebVttStream } from '@lumen/core/subtitles';
import type { FastifyBaseLogger } from 'fastify';
import { MPEG_CLOCK_HZ } from '../relay/mpegts.js';
import { type SegmenterOptions, TsSegmenter } from '../relay/segmenter.js';
import type { EncoderChoice } from '../transcode/encoders.js';
import { FIRST_SUBTITLE_FD, type TranscodeOptions, vodArgs } from '../transcode/ffmpeg-args.js';
import type { OutputPlan } from '../transcode/plan.js';
import { INPUT_ANALYSIS_ARGS, type MediaInfo } from './probe.js';
import type { VodSource } from './source-proxy.js';
import { VodSegments, type VodSegmentUri, type VodSegmentsOptions } from './vod-segments.js';

/** Fin du message d'erreur de FFmpeg gardée pour le journal (il ne cite que l'adresse locale). */
const STDERR_KEPT_CHARS = 2000;
const STDERR_LOGGED_LINES = 3;
/** Horodatages MPEG-TS : 33 bits. */
const TIMESTAMP_MODULO = 2 ** 33;

export interface VodSessionDeps {
  ffmpegPath: string;
  encoder: EncoderChoice;
  transcode: TranscodeOptions;
  segmenter: SegmenterOptions;
  segments: VodSegmentsOptions;
  /** Premier segment attendu au plus ce délai. */
  startTimeoutMs: number;
  log: FastifyBaseLogger;
}

export interface VodSessionParams {
  id: string;
  userId: string;
  info: MediaInfo;
  plan: OutputPlan;
  startS: number;
  audioIndex: number;
  /** Pistes de sous-titres texte extraites pendant la lecture. */
  textSubtitles: readonly number[];
  /** Piste de sous-titres en images incrustée ; null : aucune. */
  burnSubtitle: number | null;
}

/** Répliques d'une piste, au fil de la lecture du fichier. */
export interface CueBatch {
  cues: Cue[];
  next: number;
  complete: boolean;
}

export class VodStartError extends Error {
  override readonly name = 'VodStartError';
}

/**
 * Une lecture de film : FFmpeg lit le fichier (par le relais local) depuis la position
 * voulue, le découpeur en tire des segments HLS. La production suit le lecteur : FFmpeg
 * est mis en pause dès qu'il a assez d'avance (la sortie standard n'est plus lue, il
 * s'arrête de lui-même, et le relais local cesse de lire le portail), puis repart à la
 * demande suivante. Un film en pause ne coûte ainsi ni processeur ni données.
 */
export class VodSession {
  readonly id: string;
  readonly userId: string;
  readonly startS: number;
  readonly audioIndex: number;
  readonly plan: OutputPlan;
  readonly info: MediaInfo;
  readonly textSubtitles: readonly number[];
  readonly burnSubtitle: number | null;
  lastSeen = Date.now();
  onClose: (() => void) | null = null;

  private readonly segments: VodSegments;
  private readonly segmenter: TsSegmenter;
  private child: ChildProcess | null = null;
  /** Répliques extraites, par piste, en position dans le film. */
  private readonly cues = new Map<number, Cue[]>();
  private subtitlesComplete = false;
  private paused = false;
  private closed = false;
  private failure: Error | null = null;
  private readonly readyWaiters: (() => void)[] = [];

  constructor(
    params: VodSessionParams,
    private readonly source: VodSource,
    private readonly deps: VodSessionDeps,
  ) {
    this.id = params.id;
    this.userId = params.userId;
    this.startS = params.startS;
    this.audioIndex = params.audioIndex;
    this.plan = params.plan;
    this.info = params.info;
    this.textSubtitles = params.textSubtitles;
    this.burnSubtitle = params.burnSubtitle;
    for (const index of params.textSubtitles) this.cues.set(index, []);
    const origin = Math.round(params.info.startTimeS * MPEG_CLOCK_HZ) % TIMESTAMP_MODULO;
    this.segments = new VodSegments(deps.segments, origin, params.startS);
    this.segmenter = new TsSegmenter(deps.segmenter, (draft) => {
      // Segment d'avant la position demandée (flux lu depuis son début) : rien à annoncer.
      if (this.segments.add(draft) === null) return;
      this.notify();
      if (this.segments.full) this.pause();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  start(): void {
    const args = vodArgs(
      {
        url: this.source.url,
        startS: this.startS,
        audioIndex: this.audioIndex,
        analysisArgs: INPUT_ANALYSIS_ARGS,
        textSubtitles: this.textSubtitles,
        burnSubtitle: this.burnSubtitle,
      },
      this.plan,
      this.deps.encoder,
      this.deps.transcode,
    );
    // Une sortie de plus par piste de sous-titres texte (pipe:3, pipe:4…).
    const child = spawn(this.deps.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', ...this.textSubtitles.map(() => 'pipe' as const)],
    });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT_CHARS);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      this.segmenter.push(chunk);
    });
    this.textSubtitles.forEach((index, k) => {
      const pipe = child.stdio[FIRST_SUBTITLE_FD + k] as Readable | null | undefined;
      const parser = new WebVttStream();
      const list = this.cues.get(index) ?? [];
      const add = (cues: Cue[]): void => {
        // Horodatages du fichier (FFmpeg les garde) : la position dans le film en retranche l'origine.
        for (const c of cues) {
          list.push({ ...c, startS: c.startS - this.info.startTimeS, endS: c.endS - this.info.startTimeS });
        }
      };
      pipe?.setEncoding('utf8');
      pipe?.on('data', (chunk: string) => {
        add(parser.push(chunk));
      });
      pipe?.on('end', () => {
        add(parser.flush());
      });
    });
    child.on('error', () => {
      this.fail(new VodStartError('FFmpeg introuvable'));
    });
    child.on('close', (code) => {
      this.child = null;
      if (this.closed) return;
      this.subtitlesComplete = true;
      // Dernier morceau du fichier publié, puis playlist close : le lecteur sait que c'est la fin.
      this.segmenter.breakStream();
      if (code !== 0) {
        this.deps.log.warn(
          { session: this.id, code, stderr: stderr.trim().split('\n').slice(-STDERR_LOGGED_LINES) },
          'lecture du film interrompue par FFmpeg',
        );
      }
      if (this.segments.count === 0) {
        this.fail(new VodStartError(code === 0 ? 'fichier vide' : 'fichier illisible'));
        return;
      }
      this.segments.end();
      this.notify();
    });
  }

  /** Résolu au premier segment (ou à la fin d'un fichier très court) ; rejeté sur échec ou délai. */
  ready(): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.segments.count > 0 || this.segments.isEnded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new VodStartError('aucune image dans le délai'));
      }, this.deps.startTimeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        if (this.failure !== null) reject(this.failure);
        else resolve();
      });
    });
  }

  /** Répliques de la piste `index` à partir du rang `after` ; null si la piste n'est pas extraite. */
  subtitleCues(index: number, after: number): CueBatch | null {
    this.lastSeen = Date.now();
    const list = this.cues.get(index);
    if (list === undefined) return null;
    return { cues: list.slice(after), next: list.length, complete: this.subtitlesComplete };
  }

  playlist(uri: VodSegmentUri): string {
    this.lastSeen = Date.now();
    return this.segments.playlist(uri);
  }

  /** Segment demandé par le lecteur ; null s'il n'existe pas (encore) ou a été libéré. */
  segment(seq: number): Buffer | null {
    this.lastSeen = Date.now();
    const segment = this.segments.request(seq);
    if (this.paused && !this.segments.full) this.resume();
    return segment?.data ?? null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill('SIGKILL');
    this.child = null;
    this.source.close();
    this.notify();
    this.onClose?.();
  }

  private pause(): void {
    if (this.paused || this.child === null) return;
    this.paused = true;
    this.child.stdout?.pause();
  }

  private resume(): void {
    this.paused = false;
    this.child?.stdout?.resume();
  }

  private fail(err: Error): void {
    this.failure ??= err;
    this.notify();
  }

  private notify(): void {
    for (const waiter of this.readyWaiters.splice(0)) waiter();
  }
}

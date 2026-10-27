import { spawn } from 'node:child_process';

/** Ce que FFmpeg a vu dans un segment : secondes d'image noire et de silence. */
export interface ContentVerdict {
  blackS: number;
  silentS: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface ContentAnalyzer {
  /** null si l'analyse est impossible (FFmpeg absent, file pleine) : le segment n'est pas jugé. */
  analyze(segment: Buffer, durationS: number): Promise<ContentVerdict | null>;
}

/**
 * Filtres FFmpeg (PROJECT.md : `blackdetect`, `silencedetect`). Seuils classiques : pixel
 * « noir » sous 10 % de luminance, image noire à 98 % de pixels noirs, silence sous −50 dB.
 * Durée minimale courte : c'est le relais qui cumule les segments jusqu'à 10 s.
 */
const FILTER_ARGS = [
  '-vf',
  'blackdetect=d=0.1:pic_th=0.98:pix_th=0.10',
  '-af',
  'silencedetect=n=-50dB:d=0.1',
];
/** Une analyse qui traîne (machine saturée) est abandonnée : le segment n'est pas jugé. */
const ANALYSIS_TIMEOUT_MS = 10_000;

const sum = (text: string, pattern: RegExp): number =>
  [...text.matchAll(pattern)].reduce((s, m) => s + Number.parseFloat(m[1] ?? '0'), 0);

/** Lit la sortie d'erreur de FFmpeg (où les filtres journalisent). Exportée pour les tests. */
export function parseVerdict(stderr: string, durationS: number): ContentVerdict {
  const start = Number.parseFloat(/start:\s*([\d.]+)/.exec(stderr)?.[1] ?? '0');
  let silentS = sum(stderr, /silence_duration:\s*([\d.]+)/g);
  // Silence encore en cours à la fin du segment : FFmpeg ne publie pas sa durée.
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].length;
  const ends = [...stderr.matchAll(/silence_end:/g)].length;
  if (starts > ends) {
    const last = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].at(-1)?.[1];
    if (last !== undefined) silentS += Math.max(0, start + durationS - Number.parseFloat(last));
  }
  return {
    blackS: sum(stderr, /black_duration:\s*([\d.]+)/g),
    silentS: Math.min(durationS, silentS),
    hasVideo: /Stream #\S+.*Video:/.test(stderr),
    hasAudio: /Stream #\S+.*Audio:/.test(stderr),
  };
}

/**
 * Analyse par FFmpeg, en processus enfant, avec un nombre borné d'analyses simultanées
 * pour tout le serveur. Au-delà, un segment n'est simplement pas jugé : la détection
 * prend un peu plus longtemps, la lecture n'en souffre jamais.
 */
export class FfmpegContentAnalyzer implements ContentAnalyzer {
  private running = 0;
  private disabled = false;

  constructor(
    private readonly ffmpegPath: string,
    private readonly maxConcurrent: number,
    private readonly onUnavailable: () => void = () => undefined,
  ) {}

  analyze(segment: Buffer, durationS: number): Promise<ContentVerdict | null> {
    if (this.disabled || this.running >= this.maxConcurrent) return Promise.resolve(null);
    this.running++;
    return new Promise<ContentVerdict | null>((resolve) => {
      const child = spawn(
        this.ffmpegPath,
        ['-hide_banner', '-nostats', '-i', 'pipe:0', ...FILTER_ARGS, '-f', 'null', '-'],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
      }, ANALYSIS_TIMEOUT_MS);
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT' && !this.disabled) {
          this.disabled = true;
          this.onUnavailable();
        }
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? parseVerdict(stderr, durationS) : null);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(segment);
    }).finally(() => {
      this.running--;
    });
  }
}

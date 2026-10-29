import { spawn } from 'node:child_process';
import type { AudioCodec, VideoCodec } from '../relay/mpegts.js';

export interface AudioTrack {
  /** Rang parmi les pistes audio du fichier (FFmpeg : `0:a:<index>`). */
  index: number;
  codec: AudioCodec;
  language: string | null;
  label: string;
  isDefault: boolean;
}

/** Sous-titres texte (convertis en WebVTT, affichés par le lecteur) ou en images (incrustés). */
export type SubtitleKind = 'text' | 'image';

export interface SubtitleTrack {
  /** Rang parmi les pistes de sous-titres du fichier (FFmpeg : `0:s:<index>`). */
  index: number;
  kind: SubtitleKind;
  language: string | null;
  label: string;
  isDefault: boolean;
}

export interface MediaInfo {
  durationS: number | null;
  /** Horodatage du début du fichier (s) : les positions du film se comptent à partir de lui. */
  startTimeS: number;
  video: { codec: VideoCodec } | null;
  audio: AudioTrack[];
  /** Pistes de sous-titres affichables ; le télétexte et les formats inconnus sont écartés. */
  subtitles: SubtitleTrack[];
}

export class ProbeError extends Error {
  override readonly name = 'ProbeError';
}

/**
 * Analyse du début du fichier, pour FFprobe comme pour FFmpeg : 2 Mo et 3 s de contenu
 * suffisent à trouver pistes et codecs (les en-têtes MP4 ou MKV les listent d'emblée), là où
 * les réglages par défaut liraient jusqu'à 5 Mo avant la première image, deux fois.
 */
export const INPUT_ANALYSIS_ARGS = ['-probesize', '2000000', '-analyzeduration', '3000000'];

/** Sortie de FFprobe gardée au plus (le JSON d'un fichier à nombreuses pistes reste petit). */
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
/** Plus de deux canaux : on le dit (« 5.1 »), c'est ce qui distingue souvent deux pistes d'une même langue. */
const STEREO_CHANNELS = 2;
const SURROUND_LABELS: Record<number, string> = { 6: '5.1', 8: '7.1' };

/** Codes ISO 639 (1, 2/B et 2/T) des langues les plus courantes des portails : un nom lisible. */
const LANGUAGE_NAMES: Record<string, string> = {
  fr: 'Français',
  fra: 'Français',
  fre: 'Français',
  en: 'Anglais',
  eng: 'Anglais',
  ar: 'Arabe',
  ara: 'Arabe',
  es: 'Espagnol',
  spa: 'Espagnol',
  pt: 'Portugais',
  por: 'Portugais',
  de: 'Allemand',
  deu: 'Allemand',
  ger: 'Allemand',
  it: 'Italien',
  ita: 'Italien',
  tr: 'Turc',
  tur: 'Turc',
  hi: 'Hindi',
  hin: 'Hindi',
  wo: 'Wolof',
  wol: 'Wolof',
  ha: 'Haoussa',
  hau: 'Haoussa',
  sw: 'Swahili',
  swa: 'Swahili',
};

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const IMAGE_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

export function subtitleKindOf(name: string): SubtitleKind | null {
  if (TEXT_SUBTITLE_CODECS.has(name)) return 'text';
  if (IMAGE_SUBTITLE_CODECS.has(name)) return 'image';
  return null;
}

const languageOf = (s: ProbeStream): string | null => {
  const code = s.tags?.['language']?.toLowerCase();
  return code === undefined || code === '' || code === 'und' ? null : code;
};

export function videoCodecOf(name: string): VideoCodec {
  switch (name) {
    case 'h264':
      return 'h264';
    case 'hevc':
      return 'hevc';
    case 'mpeg2video':
      return 'mpeg2';
    default:
      return 'other';
  }
}

export function audioCodecOf(name: string): AudioCodec {
  switch (name) {
    case 'aac':
      return 'aac';
    case 'mp3':
      return 'mp3';
    case 'ac3':
      return 'ac3';
    case 'eac3':
      return 'eac3';
    default:
      return 'other';
  }
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; start_time?: string };
}

const finite = (v: string | undefined): number | null => {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? null : n;
};

/** Propriétés utiles d'un fichier, tirées de `ffprobe -show_format -show_streams -of json`. */
export function parseProbe(output: unknown): MediaInfo {
  const probe = (output ?? {}) as ProbeOutput;
  const streams = probe.streams ?? [];
  // Une affiche intégrée (pochette MP4) n'est pas la vidéo du film.
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.['attached_pic'] !== 1);
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, index): AudioTrack => {
      const language = languageOf(s);
      const title = s.tags?.['title']?.trim();
      const surround =
        (s.channels ?? 0) > STEREO_CHANNELS
          ? (SURROUND_LABELS[s.channels ?? 0] ?? `${s.channels} canaux`)
          : null;
      const name =
        title !== undefined && title !== ''
          ? title
          : language === null
            ? `Piste ${index + 1}`
            : (LANGUAGE_NAMES[language] ?? language.toUpperCase());
      return {
        index,
        codec: audioCodecOf(s.codec_name ?? ''),
        language,
        label: surround === null || name.includes(surround) ? name : `${name} (${surround})`,
        isDefault: s.disposition?.['default'] === 1,
      };
    });
  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s, index): SubtitleTrack | null => {
      const kind = subtitleKindOf(s.codec_name ?? '');
      if (kind === null) return null;
      const language = languageOf(s);
      const title = s.tags?.['title']?.trim();
      const name =
        title !== undefined && title !== ''
          ? title
          : language === null
            ? `Sous-titres ${index + 1}`
            : (LANGUAGE_NAMES[language] ?? language.toUpperCase());
      const forced = s.disposition?.['forced'] === 1;
      return {
        index,
        kind,
        language,
        label: forced && !name.includes('forcés') ? `${name} (forcés)` : name,
        isDefault: s.disposition?.['default'] === 1,
      };
    })
    .filter((t): t is SubtitleTrack => t !== null);
  const duration = finite(probe.format?.duration);
  return {
    durationS: duration !== null && duration > 0 ? duration : null,
    startTimeS: finite(probe.format?.start_time) ?? 0,
    video: video === undefined ? null : { codec: videoCodecOf(video.codec_name ?? '') },
    audio,
    subtitles,
  };
}

/** Piste jouée sans choix du spectateur : celle que le fichier désigne, sinon la première. */
export const defaultAudioTrack = (info: MediaInfo): number => info.audio.find((t) => t.isDefault)?.index ?? 0;

/**
 * Lit les propriétés d'un fichier. `url` est l'adresse du relais local : ni FFprobe ni
 * ses messages ne voient l'adresse du portail.
 */
export function probeMedia(ffprobePath: string, url: string, timeoutMs: number): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    // prettier-ignore
    const child = spawn(ffprobePath, [
      '-v', 'error', ...INPUT_ANALYSIS_ARGS, '-show_format', '-show_streams', '-of', 'json', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ProbeError('propriétés du fichier : délai dépassé'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_PROBE_OUTPUT_BYTES) chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new ProbeError('FFprobe introuvable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ProbeError('fichier illisible'));
        return;
      }
      try {
        resolve(parseProbe(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch {
        reject(new ProbeError('propriétés du fichier illisibles'));
      }
    });
  });
}

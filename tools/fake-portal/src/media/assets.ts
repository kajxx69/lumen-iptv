import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaConfig } from '../config.js';
import { FakePortalError } from '../errors.js';
import {
  ContinuityRewriter,
  MPEG_CLOCK_HZ,
  TS_PACKET_SIZE,
  assertAligned,
  dropPes,
  isAudioStream,
  isVideoStream,
  listPes,
} from './mpegts.js';

export type AssetKind = 'mire' | 'black';

/** Une boucle vidéo pré-encodée, découpée en segments alignés sur les images clés. */
export interface LoopAsset {
  kind: AssetKind;
  segments: readonly Buffer[];
  segmentDurationS: number;
  loopDurationS: number;
  /** PTS de la première image vidéo : origine des temps relatifs de la boucle. */
  baseVideoPts: number;
  /** Packets TS par segment : sert au découpage cadencé. */
  packetCounts: readonly number[];
}

export interface MediaAssets {
  mire: LoopAsset;
  black: LoopAsset;
}

// Tolérance sur la durée de segment annoncée par FFmpeg (EXTINF arrondi à la microseconde).
const SEGMENT_DURATION_TOLERANCE_S = 0.05;
// Incrémenté quand les paramètres d'encodage changent, pour invalider le cache disque.
const ASSET_FORMAT_VERSION = 2;
const PLAYLIST_NAME = 'index.m3u8';

function sourceArgs(kind: AssetKind, media: MediaConfig): string[] {
  if (kind === 'mire') {
    // testsrc incruste un compteur de temps : un gel se voit immédiatement à l'image.
    // Le bip à 1 kHz chaque seconde rend aussi les gels audibles.
    return [
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${media.videoSize}:rate=${media.fps}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=1000:beep_factor=4:sample_rate=${media.audioSampleRate}`,
    ];
  }
  return [
    '-f',
    'lavfi',
    '-i',
    `color=c=black:size=${media.videoSize}:rate=${media.fps}`,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=stereo:sample_rate=${media.audioSampleRate}`,
  ];
}

/** Seuil de détection de scène que FFmpeg demande pour un GOP MPEG-2 fermé. */
const MPEG2_NO_SCENECUT = 1_000_000_000;

/** Encodage vidéo : GOP fermé de la durée d'un segment, sans images B, débit constant. */
function videoArgs(media: MediaConfig): string[] {
  const gop = String(media.fps * media.segmentDurationS);
  const v = `${media.videoBitrateKbps}k`;
  const rate = ['-b:v', v, '-minrate', v, '-maxrate', v, '-bufsize', v];
  const gopArgs = ['-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-bf', '0'];
  switch (media.videoCodec) {
    case 'h264':
      // prettier-ignore
      return [
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        ...gopArgs,
        // CBR strict : débit constant, y compris sur l'écran noir, comme un encodeur de diffusion.
        ...rate, '-x264-params', 'nal-hrd=cbr',
      ];
    case 'hevc':
      // prettier-ignore
      return [
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...gopArgs, ...rate,
        '-x265-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0:bframes=0:open-gop=0:log-level=error`,
      ];
    case 'mpeg2':
      // GOP fermé : FFmpeg exige alors de neutraliser la détection de scène par un seuil géant.
      // prettier-ignore
      return [
        '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-flags', '+cgop',
        '-g', gop, '-keyint_min', gop, '-sc_threshold', String(MPEG2_NO_SCENECUT), '-bf', '0', ...rate,
      ];
  }
}

function audioArgs(media: MediaConfig): string[] {
  const common = ['-ac', '2', '-ar', String(media.audioSampleRate)];
  switch (media.audioCodec) {
    case 'aac':
      return ['-c:a', 'aac', '-b:a', `${media.audioBitrateKbps}k`, ...common];
    case 'ac3':
      // Débit habituel d'une piste AC-3 stéréo de diffusion.
      return ['-c:a', 'ac3', '-b:a', '192k', ...common];
  }
}

export function ffmpegArgs(kind: AssetKind, media: MediaConfig, outDir: string): string[] {
  // prettier-ignore
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...sourceArgs(kind, media),
    '-t', String(media.loopDurationS),
    '-map', '0:v', '-map', '1:a',
    ...videoArgs(media),
    ...audioArgs(media),
    '-f', 'hls', '-hls_time', String(media.segmentDurationS), '-hls_list_size', '0',
    '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
    // Une trame audio par PES : permet de retirer précisément la trame d'amorçage AAC.
    '-hls_segment_options', 'pes_payload_size=0',
    '-hls_segment_filename', join(outDir, 'seg_%03d.ts'),
    join(outDir, PLAYLIST_NAME),
  ];
}

function assetDirName(kind: AssetKind, media: MediaConfig): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ v: ASSET_FORMAT_VERSION, kind, media }))
    .digest('hex')
    .slice(0, 12);
  return `${kind}-${hash}`;
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new FakePortalError(
              'FFMPEG_NOT_FOUND',
              `FFmpeg introuvable (${ffmpegPath}). Installez-le ou définissez FFMPEG_PATH.`,
              { cause: err },
            )
          : new FakePortalError('FFMPEG_FAILED', `Lancement de FFmpeg impossible`, { cause: err }),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new FakePortalError('FFMPEG_FAILED', `FFmpeg a échoué (code ${String(code)}) : ${stderr.trim()}`),
        );
    });
  });
}

async function ensureGenerated(
  kind: AssetKind,
  media: MediaConfig,
  assetDir: string,
  ffmpegPath: string,
): Promise<string> {
  const dir = join(assetDir, assetDirName(kind, media));
  if (existsSync(join(dir, PLAYLIST_NAME))) return dir;
  await mkdir(assetDir, { recursive: true });
  // Génération dans un dossier temporaire puis renommage : jamais de cache à moitié écrit.
  const tmp = join(assetDir, `.tmp-${kind}-${randomUUID()}`);
  await mkdir(tmp);
  try {
    await runFfmpeg(ffmpegPath, ffmpegArgs(kind, media, tmp));
    await rename(tmp, dir).catch(async (err: unknown) => {
      // Un autre processus a fini la même génération en premier.
      if (!existsSync(join(dir, PLAYLIST_NAME))) throw err;
      await rm(tmp, { recursive: true, force: true });
    });
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

interface PlaylistEntry {
  durationS: number;
  file: string;
}

function parseVodPlaylist(text: string): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  let pending: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      pending = Number.parseFloat(line.slice('#EXTINF:'.length));
    } else if (line !== '' && !line.startsWith('#') && pending !== null) {
      entries.push({ durationS: pending, file: line });
      pending = null;
    }
  }
  return entries;
}

async function loadAsset(kind: AssetKind, media: MediaConfig, dir: string): Promise<LoopAsset> {
  const entries = parseVodPlaylist(await readFile(join(dir, PLAYLIST_NAME), 'utf8'));
  const expected = media.loopDurationS / media.segmentDurationS;
  if (entries.length !== expected) {
    throw new FakePortalError('ASSET_INVALID', `${kind} : ${entries.length} segments au lieu de ${expected}`);
  }
  const segments: Buffer[] = [];
  for (const entry of entries) {
    if (Math.abs(entry.durationS - media.segmentDurationS) > SEGMENT_DURATION_TOLERANCE_S) {
      throw new FakePortalError('ASSET_INVALID', `${kind} : segment ${entry.file} de ${entry.durationS} s`);
    }
    const buf = await readFile(join(dir, entry.file));
    assertAligned(buf);
    segments.push(buf);
  }
  const firstVideo = listPes(segments[0] ?? Buffer.alloc(0)).find(
    (p) => isVideoStream(p.streamId) && p.pts !== null,
  );
  if (firstVideo?.pts == null) {
    throw new FakePortalError(
      'ASSET_INVALID',
      `${kind} : aucune image vidéo horodatée dans le premier segment`,
    );
  }
  const base = firstVideo.pts;
  const loop = media.loopDurationS * MPEG_CLOCK_HZ;
  // L'encodeur AAC ajoute une trame d'amorçage avant la première image : elle chevaucherait
  // la dernière trame de la boucle précédente (DTS dupliqué au rebouclage). On garde
  // exactement [0, durée de boucle) d'audio.
  const continuity = new ContinuityRewriter();
  const trimmed = segments.map((seg) => {
    const out = dropPes(
      seg,
      (p) => isAudioStream(p.streamId) && p.pts !== null && (p.pts - base < 0 || p.pts - base >= loop),
    );
    continuity.rewrite(out);
    return out;
  });
  return {
    kind,
    segments: trimmed,
    segmentDurationS: media.segmentDurationS,
    loopDurationS: media.loopDurationS,
    baseVideoPts: base,
    packetCounts: trimmed.map((s) => s.length / TS_PACKET_SIZE),
  };
}

export async function loadMediaAssets(
  media: MediaConfig,
  assetDir: string,
  ffmpegPath: string,
): Promise<MediaAssets> {
  if (media.loopDurationS % media.segmentDurationS !== 0) {
    throw new FakePortalError('ASSET_INVALID', 'loopDurationS doit être un multiple de segmentDurationS');
  }
  const [mireDir, blackDir] = await Promise.all([
    ensureGenerated('mire', media, assetDir, ffmpegPath),
    ensureGenerated('black', media, assetDir, ffmpegPath),
  ]);
  const [mire, black] = await Promise.all([
    loadAsset('mire', media, mireDir),
    loadAsset('black', media, blackDir),
  ]);
  return { mire, black };
}

export const loopTicks = (asset: LoopAsset): number => asset.loopDurationS * MPEG_CLOCK_HZ;

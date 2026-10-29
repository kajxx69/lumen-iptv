import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFfmpeg } from './assets.js';

/** Une réplique toutes les 4 s, affichée 3 s : de quoi vérifier synchronisation et changement de piste. */
const CUE_INTERVAL_S = 4;
const CUE_DURATION_S = 3;

function srtTime(totalS: number): string {
  const ms = Math.round(totalS * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${two(h)}:${two(m)}:${two(s)},${String(ms % 1000).padStart(3, '0')}`;
}

/** Sous-titres SRT : « Réplique 1 » à 0 s, « Réplique 2 » à 4 s… (le numéro dit la position). */
export function srtCues(durationS: number, word: string): string {
  const cues: string[] = [];
  for (let i = 0; i * CUE_INTERVAL_S + CUE_DURATION_S <= durationS; i++) {
    const start = i * CUE_INTERVAL_S;
    cues.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(start + CUE_DURATION_S)}\n${word} ${i + 1}\n`);
  }
  return cues.join('\n');
}

/**
 * Film « multilingue », comme beaucoup de fichiers des vrais portails : conteneur MKV, deux
 * pistes audio (français par défaut, anglais) et deux pistes de sous-titres texte.
 */
export async function buildMultilingualMovie(
  ffmpegPath: string,
  ts: Buffer,
  durationS: number,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'lumen-fake-mkv-'));
  try {
    const input = join(dir, 'film.ts');
    const fr = join(dir, 'fr.srt');
    const en = join(dir, 'en.srt');
    const out = join(dir, 'film.mkv');
    await writeFile(input, ts);
    await writeFile(fr, srtCues(durationS, 'Réplique'));
    await writeFile(en, srtCues(durationS, 'Line'));
    // prettier-ignore
    await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input, '-i', fr, '-i', en,
      '-map', '0:v', '-map', '0:a', '-map', '0:a', '-map', '1', '-map', '2',
      '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=fre', '-metadata:s:a:1', 'language=eng',
      '-metadata:s:s:0', 'language=fre', '-metadata:s:s:1', 'language=eng',
      '-disposition:a:0', 'default', '-disposition:a:1', '0',
      '-disposition:s:0', '0', '-disposition:s:1', '0',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

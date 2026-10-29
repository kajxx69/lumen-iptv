/**
 * Sous-titres texte (WebVTT et SRT) : lecture complète d'un fichier, ou au fil de l'eau
 * (sortie WebVTT de FFmpeg pendant la lecture d'un film). Pur, sans dépendance : le serveur
 * et le navigateur partagent le même analyseur.
 */

export interface Cue {
  startS: number;
  endS: number;
  text: string;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
/** « 01:02:03.456 », « 02:03.456 », et la virgule du SRT (« 00:02:03,456 »). */
const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const TIMING = /^\s*(\S+)\s+-->\s+(\S+)/;
/** Balises de mise en forme (WebVTT, SRT, ASS) : le lecteur affiche le texte seul. */
const MARKUP = /<[^>]*>|\{\\[^}]*\}/g;

export function parseTime(value: string): number | null {
  const m = TIME.exec(value.trim());
  if (m === null) return null;
  const [, h = '0', min = '0', s = '0', frac = '0'] = m;
  return (
    Number(h) * SECONDS_PER_HOUR +
    Number(min) * SECONDS_PER_MINUTE +
    Number(s) +
    Number(frac.padEnd(3, '0')) / 1000
  );
}

/** Un bloc (séparé par une ligne vide) : la réplique qu'il contient, ou null (en-tête, note, style). */
function parseBlock(block: string): Cue | null {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => l.includes('-->'));
  if (at < 0) return null;
  const timing = TIMING.exec(lines[at] ?? '');
  if (timing === null) return null;
  const startS = parseTime(timing[1] ?? '');
  const endS = parseTime(timing[2] ?? '');
  if (startS === null || endS === null || endS <= startS) return null;
  const text = lines
    .slice(at + 1)
    .map((l) => l.replace(MARKUP, '').replace(/\\N/g, '\n').trim())
    .filter((l) => l !== '')
    .join('\n');
  return text === '' ? null : { startS, endS, text };
}

/** Marque d'ordre des octets en tête de certains fichiers SRT (Windows). */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

const normalize = (text: string): string => text.replace(BOM, '').replace(/\r\n?/g, '\n');

/** Fichier SRT ou WebVTT complet → répliques, dans l'ordre. */
export function parseSubtitles(text: string): Cue[] {
  return normalize(text)
    .split(/\n{2,}/)
    .map(parseBlock)
    .filter((c): c is Cue => c !== null)
    .sort((a, b) => a.startS - b.startS);
}

/**
 * WebVTT reçu par morceaux : chaque bloc est rendu dès qu'il est complet (ligne vide qui
 * suit). `flush` rend le dernier, à la fin du flux.
 */
export class WebVttStream {
  private pending = '';

  push(chunk: string): Cue[] {
    this.pending = normalize(this.pending + chunk);
    const blocks = this.pending.split(/\n{2,}/);
    this.pending = blocks.pop() ?? '';
    return blocks.map(parseBlock).filter((c): c is Cue => c !== null);
  }

  flush(): Cue[] {
    const last = parseBlock(this.pending);
    this.pending = '';
    return last === null ? [] : [last];
  }
}

/** Réplique affichée à cet instant (la plus récente si plusieurs se chevauchent). */
export function activeCue(cues: readonly Cue[], positionS: number): Cue | null {
  // Les répliques sont triées par début : dichotomie sur le dernier début ≤ position.
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cues[mid]?.startS ?? 0) <= positionS) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0 && i >= lo - 4; i--) {
    const cue = cues[i];
    if (cue !== undefined && positionS < cue.endS) return cue;
  }
  return null;
}

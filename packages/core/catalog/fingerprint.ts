/**
 * Empreinte d'une chaîne (PROJECT.md, fusion multi-sources, étape 2) : nom normalisé,
 * identifiant EPG, et ressemblance de la grille de programmes sur 6 heures. La grille est
 * le signal le plus fiable : elle sert à confirmer ou refuser les rapprochements proposés
 * par le nom et l'identifiant EPG.
 */
import { normalizeName, stripAccents } from './normalize.js';

/**
 * Pays écrits en suffixe par certains portails (« Nova TV France 1080 ») : ils ne
 * distinguent pas deux chaînes, au contraire du préfixe de « France 24 » qui fait partie
 * du nom. Formes normalisées (minuscules, sans accents, mots séparés).
 */
const COUNTRY_SUFFIXES: readonly string[][] = [
  'france',
  'belgique',
  'suisse',
  'canada',
  'maroc',
  'algerie',
  'tunisie',
  'senegal',
  'mali',
  'burkina',
  'burkina faso',
  'cote d ivoire',
  'cameroun',
  'benin',
  'togo',
  'niger',
  'guinee',
  'gabon',
  'congo',
  'rdc',
  'nigeria',
  'ghana',
  'royaume uni',
  'etats unis',
  'usa',
  'allemagne',
  'espagne',
  'italie',
  'portugal',
  // Codes pays en suffixe (« TV5 Monde FR »).
  'fr',
  'be',
  'ch',
  'ca',
  'ma',
  'dz',
  'tn',
  'sn',
  'ci',
  'cm',
  'uk',
  'us',
].map((c) => c.split(' '));

const endsWith = (words: readonly string[], suffix: readonly string[]): boolean =>
  words.length > suffix.length && suffix.every((w, i) => words[words.length - suffix.length + i] === w);

/** Nom réduit à ce qui identifie la chaîne : sans pays, qualité, ni variante d'écriture du « + ». */
export function fingerprintName(name: string): string {
  let words = normalizeName(name).split(' ');
  const country = COUNTRY_SUFFIXES.find((suffix) => endsWith(words, suffix));
  if (country !== undefined) words = words.slice(0, words.length - country.length);
  // « Canal Plus », « Canal + », « Canal+ » : une même chaîne.
  const out: string[] = [];
  for (const w of words) {
    const last = out.length - 1;
    if ((w === '+' || w === 'plus') && last >= 0) out[last] = `${out[last] ?? ''}+`;
    else out.push(w);
  }
  return out.join(' ');
}

export interface GridProgramme {
  title: string;
  start: number;
  end: number;
}

export interface GridMatchOptions {
  /** Fenêtre comparée : 6 h (PROJECT.md), assez pour plusieurs programmes. */
  windowMs: number;
  /** Pas d'échantillonnage : 5 min absorbe les décalages d'horloge entre portails. */
  slotMs: number;
  /** Part minimale de la fenêtre couverte par les deux grilles pour oser un avis. */
  minCoverage: number;
  /** À partir de cette ressemblance, même chaîne. */
  sameAt: number;
  /** En dessous, chaînes différentes : le rapprochement est refusé. */
  differentAt: number;
}

export const GRID_MATCH: GridMatchOptions = {
  windowMs: 6 * 3_600_000,
  slotMs: 5 * 60_000,
  minCoverage: 0.5,
  sameAt: 0.6,
  differentAt: 0.2,
};

export type GridVerdict = 'same' | 'different';

export interface GridComparison {
  /** Part des instants où les deux chaînes diffusent le même programme ; null sans avis possible. */
  similarity: number | null;
  verdict: GridVerdict | null;
}

const normalizeTitle = (title: string): string =>
  stripAccents(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function titleAt(grid: readonly GridProgramme[], t: number): string | null {
  for (const p of grid) if (p.start <= t && t < p.end) return normalizeTitle(p.title);
  return null;
}

/** Compare deux grilles sur la fenêtre qui commence à `from`. */
export function compareGrids(
  a: readonly GridProgramme[],
  b: readonly GridProgramme[],
  from: number,
  options: GridMatchOptions = GRID_MATCH,
): GridComparison {
  const slots = Math.floor(options.windowMs / options.slotMs);
  let covered = 0;
  let matches = 0;
  for (let i = 0; i < slots; i++) {
    // Milieu du créneau : loin des changements de programme, là où les horloges divergent.
    const t = from + i * options.slotMs + options.slotMs / 2;
    const ta = titleAt(a, t);
    const tb = titleAt(b, t);
    if (ta === null || tb === null) continue;
    covered++;
    if (ta === tb) matches++;
  }
  if (slots === 0 || covered / slots < options.minCoverage) return { similarity: null, verdict: null };
  const similarity = matches / covered;
  const verdict =
    similarity >= options.sameAt ? 'same' : similarity <= options.differentAt ? 'different' : null;
  return { similarity, verdict };
}

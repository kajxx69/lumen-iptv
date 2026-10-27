/**
 * Normalisation des noms de chaînes (PROJECT.md, fusion multi-sources, étape 1) : retire
 * préfixes pays, marqueurs de qualité et caractères parasites, passe en minuscules sans
 * accents. Sert à la recherche locale dès maintenant, à l'empreinte de fusion en phase 6.
 */

/** Préfixe pays des portails : `FR | `, `FR: `, `|AR| `, `[UK] `, `DE - `. */
const COUNTRY_PREFIX = /^\s*(?:[[|(]\s*[a-z]{2,3}\s*[\]|)]|[a-z]{2,3}\s*[|:]|[a-z]{2,3}\s+-)\s*/i;
/** Marqueurs de qualité ou de codec, en mots entiers : ils ne distinguent pas deux chaînes. */
const QUALITY_MARKERS = new Set([
  'sd',
  'hd',
  'fhd',
  'uhd',
  'hq',
  'lq',
  '4k',
  '8k',
  'hdr',
  'hevc',
  'h264',
  'h265',
  'x264',
  'x265',
  '480p',
  '576p',
  '720p',
  '1080p',
  '1080i',
  '2160p',
  '480',
  '576',
  '720',
  '1080',
  '2160',
  '50fps',
  '60fps',
]);
const DIACRITICS = /\p{M}/gu;
// Le « + » distingue des chaînes (Canal+ / Canal) : il est conservé.
const SEPARATORS = /[^\p{L}\p{N}+]+/gu;

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(DIACRITICS, '');
}

export function normalizeName(name: string): string {
  const base = stripAccents(name.replace(COUNTRY_PREFIX, '')).toLowerCase();
  const words = base.split(SEPARATORS).filter((w) => w !== '');
  const kept = words.filter((w) => !QUALITY_MARKERS.has(w));
  // Un nom fait seulement de marqueurs (« HD ») reste reconnaissable plutôt que vide.
  return (kept.length > 0 ? kept : words).join(' ');
}

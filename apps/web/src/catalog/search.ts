import { normalizeName } from '@lumen/core/catalog';

export interface SearchableChannel {
  /** Clé unique `portail:chaîne`. */
  key: string;
  name: string;
  number: number;
}

/** À partir de cette longueur, un mot tolère une faute de frappe. */
const FUZZY_MIN_TERM_LENGTH = 4;
/** Résultats rendus au plus : une recherche n'a pas besoin de 100 000 lignes. */
export const SEARCH_MAX_RESULTS = 200;
/** Un mot identique pèse plus qu'un simple début de mot (« tf1 » avant « tf1 séries »). */
const EXACT_WEIGHT = 3;
const PREFIX_WEIGHT = 2;
const FUZZY_WEIGHT = 1;
const TOKEN_SEPARATOR = ' ';

/**
 * Index inversé local, sans réseau ni dépendance. Préfixes (« can » trouve Canal+), tous
 * les mots doivent correspondre, accents et marqueurs de qualité ignorés, numéro de chaîne,
 * faute de frappe tolérée en second recours. Cible PROJECT.md : < 50 ms sur 100 000 entrées.
 *
 * Pourquoi pas MiniSearch : son calcul de pertinence sur des dizaines de milliers de
 * correspondances (une lettre tapée) dépassait 100 ms ici. Les tableaux typés et un
 * vocabulaire trié (recherche de préfixe par dichotomie) tiennent la cible.
 */
export class ChannelSearch {
  private readonly keys: string[];
  private readonly nameLengths: Uint16Array;
  /** Mots distincts, triés : un préfixe y désigne une plage contiguë. */
  private readonly vocab: string[];
  private readonly postings: Int32Array[];
  // Tampons réutilisés d'une recherche à l'autre : aucune allocation par frappe.
  private readonly score: Float32Array;
  private readonly hits: Uint8Array;
  private readonly termWeight: Uint8Array;

  constructor(channels: readonly SearchableChannel[]) {
    this.keys = channels.map((c) => c.key);
    this.nameLengths = new Uint16Array(channels.length);
    const lists = new Map<string, number[]>();
    channels.forEach((c, doc) => {
      const normalized = normalizeName(c.name);
      this.nameLengths[doc] = Math.min(normalized.length, 0xffff);
      const tokens = new Set(normalized.split(TOKEN_SEPARATOR).filter((t) => t !== ''));
      tokens.add(String(c.number));
      for (const t of tokens) {
        const list = lists.get(t);
        if (list === undefined) lists.set(t, [doc]);
        else list.push(doc);
      }
    });
    this.vocab = [...lists.keys()].sort();
    this.postings = this.vocab.map((t) => Int32Array.from(lists.get(t) ?? []));
    this.score = new Float32Array(channels.length);
    this.hits = new Uint8Array(channels.length);
    this.termWeight = new Uint8Array(channels.length);
  }

  get size(): number {
    return this.keys.length;
  }

  /** Clés des chaînes trouvées, les plus pertinentes d'abord. */
  search(query: string): string[] {
    const terms = [
      ...new Set(
        normalizeName(query)
          .split(TOKEN_SEPARATOR)
          .filter((t) => t !== ''),
      ),
    ];
    if (terms.length === 0) return [];
    const exact = this.run(terms, false);
    return exact.length > 0 ? exact : this.run(terms, true);
  }

  private run(terms: readonly string[], fuzzy: boolean): string[] {
    const touched: number[] = [];
    for (const term of terms) {
      const termDocs: number[] = [];
      this.forEachMatch(term, fuzzy, (doc, weight) => {
        if (this.termWeight[doc] === 0) termDocs.push(doc);
        if (weight > (this.termWeight[doc] ?? 0)) this.termWeight[doc] = weight;
      });
      for (const doc of termDocs) {
        if (this.hits[doc] === 0) touched.push(doc);
        this.hits[doc] = (this.hits[doc] ?? 0) + 1;
        this.score[doc] = (this.score[doc] ?? 0) + (this.termWeight[doc] ?? 0);
        this.termWeight[doc] = 0;
      }
    }
    const found = touched.filter((doc) => this.hits[doc] === terms.length);
    // Plus pertinent d'abord ; à égalité, le nom le plus court (le plus proche de la saisie),
    // puis l'ordre du portail.
    found.sort(
      (a, b) =>
        (this.score[b] ?? 0) - (this.score[a] ?? 0) ||
        (this.nameLengths[a] ?? 0) - (this.nameLengths[b] ?? 0) ||
        a - b,
    );
    for (const doc of touched) {
      this.hits[doc] = 0;
      this.score[doc] = 0;
    }
    return found.slice(0, SEARCH_MAX_RESULTS).map((doc) => this.keys[doc] ?? '');
  }

  private forEachMatch(term: string, fuzzy: boolean, visit: (doc: number, weight: number) => void): void {
    const emit = (index: number, weight: number): void => {
      for (const doc of this.postings[index] ?? []) visit(doc, weight);
    };
    if (!fuzzy) {
      for (let i = lowerBound(this.vocab, term); i < this.vocab.length; i++) {
        const word = this.vocab[i] ?? '';
        if (!word.startsWith(term)) break;
        emit(i, word === term ? EXACT_WEIGHT : PREFIX_WEIGHT);
      }
      return;
    }
    if (term.length < FUZZY_MIN_TERM_LENGTH) return;
    // Le vocabulaire est bien plus petit que le catalogue : on le parcourt en entier.
    this.vocab.forEach((word, i) => {
      if (withinOneEdit(term, word) || withinOneEdit(term, word.slice(0, term.length))) emit(i, FUZZY_WEIGHT);
    });
  }
}

function lowerBound(sorted: readonly string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? '') < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Vrai si une seule substitution, insertion ou suppression sépare les deux mots. */
export function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

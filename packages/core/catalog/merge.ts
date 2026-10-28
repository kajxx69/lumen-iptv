/**
 * Fusion multi-portails (PROJECT.md, étape 3) : une entrée unique par chaîne, portant
 * toutes ses sources. Deux chaînes sont rapprochées si elles partagent un identifiant EPG
 * ou une empreinte de nom ; une grille de programmes différente (vérifiée en arrière-plan)
 * refuse le rapprochement ; les corrections manuelles l'emportent sur tout.
 */
import { type GridVerdict, fingerprintName } from './fingerprint.js';

export interface MergeEntry {
  portalId: string;
  channelId: string;
  name: string;
  epgId: string | null;
  /** Empreinte du nom déjà calculée (à la synchronisation) : évite de la recalculer à chaque fusion. */
  fingerprint?: string;
}

export interface ChannelGroup<T extends MergeEntry = MergeEntry> {
  /** Identifiant stable : il ne dépend ni de l'ordre des portails ni des sources ajoutées. */
  key: string;
  members: T[];
}

/** Correction manuelle : la chaîne est mise à part, seule. */
export const MERGE_SOLO = 'solo';

export interface MergeOptions {
  /** Avis de la comparaison des grilles, par paire (voir `pairKey`). */
  verdicts?: ReadonlyMap<string, GridVerdict>;
  /** Corrections manuelles, par chaîne (voir `refKey`) : MERGE_SOLO ou la clé du groupe visé. */
  overrides?: ReadonlyMap<string, string>;
}

export const refKey = (ref: { portalId: string; channelId: string }): string =>
  `${ref.portalId}:${ref.channelId}`;

/** Clé d'une paire de chaînes, indépendante de l'ordre. */
export function pairKey(
  a: { portalId: string; channelId: string },
  b: { portalId: string; channelId: string },
): string {
  const ka = refKey(a);
  const kb = refKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

const epgKey = (epgId: string): string => `e:${epgId.trim().toLowerCase()}`;
const nameKey = (fingerprint: string): string => `n:${fingerprint}`;

/** Clé la plus fréquente du groupe, à égalité la plus petite : stable quand des sources s'ajoutent. */
function dominant(keys: readonly string[]): string | null {
  // Cas courant : une seule clé, ou toutes identiques.
  const first = keys[0];
  if (first === undefined) return null;
  if (keys.every((k) => k === first)) return first;
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && k < best)) {
      best = k;
      bestCount = n;
    }
  }
  return best;
}

export function mergeChannels<T extends MergeEntry>(
  entries: readonly T[],
  options: MergeOptions = {},
): ChannelGroup<T>[] {
  const overrides = options.overrides ?? new Map<string, string>();
  const overridden =
    overrides.size === 0 ? (): boolean => false : (entry: T): boolean => overrides.has(refKey(entry));
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    // Compression du chemin : la fusion de 100 000 entrées reste linéaire en pratique.
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c] ?? r;
      parent[c] = r;
      c = next;
    }
    return r;
  };

  // Refus de la grille, par indices : peu nombreux, vérifiés à chaque union.
  const vetoes: [number, number][] = [];
  if (options.verdicts !== undefined && options.verdicts.size > 0) {
    const index = new Map(entries.map((entry, i) => [refKey(entry), i]));
    for (const [pair, verdict] of options.verdicts) {
      if (verdict !== 'different') continue;
      const [ka, kb] = pair.split('|');
      const ia = index.get(ka ?? '');
      const ib = index.get(kb ?? '');
      if (ia !== undefined && ib !== undefined) vetoes.push([ia, ib]);
    }
  }
  const union = (i: number, j: number): boolean => {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) return true;
    for (const [a, b] of vetoes) {
      const ra = find(a);
      const rb = find(b);
      if ((ra === ri && rb === rj) || (ra === rj && rb === ri)) return false;
    }
    parent[rj] = ri;
    return true;
  };

  // Rapprochement automatique : seau par clé, chaque membre rejoint un membre déjà placé.
  const fingerprints = entries.map((entry) => entry.fingerprint ?? fingerprintName(entry.name));
  const buckets = new Map<string, number[]>();
  entries.forEach((entry, i) => {
    if (overridden(entry)) return;
    const keys = [];
    if (entry.epgId !== null && entry.epgId.trim() !== '') keys.push(epgKey(entry.epgId));
    if (fingerprints[i] !== '') keys.push(nameKey(fingerprints[i] ?? ''));
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [i]);
      else bucket.push(i);
    }
  });
  for (const bucket of buckets.values()) {
    for (let k = 1; k < bucket.length; k++) {
      const i = bucket[k] ?? 0;
      for (let m = 0; m < k; m++) if (union(bucket[m] ?? 0, i)) break;
    }
  }

  // Groupes dans l'ordre d'arrivée de leur premier membre.
  const byRoot = new Map<number, number[]>();
  entries.forEach((entry, i) => {
    if (overridden(entry)) return;
    const root = find(i);
    const members = byRoot.get(root);
    if (members === undefined) byRoot.set(root, [i]);
    else members.push(i);
  });
  const groups: ChannelGroup<T>[] = [];
  const byKey = new Map<string, ChannelGroup<T>>();
  const add = (key: string, members: T[]): ChannelGroup<T> => {
    // Deux groupes que la grille a séparés peuvent prétendre à la même clé.
    let unique = key;
    for (let n = 2; byKey.has(unique); n++) unique = `${key}#${n}`;
    const group = { key: unique, members };
    groups.push(group);
    byKey.set(unique, group);
    return group;
  };
  for (const indices of byRoot.values()) {
    const members = indices.map((i) => entries[i]).filter((m): m is T => m !== undefined);
    const first = members[0];
    if (first === undefined) continue;
    const epgKeys = members.flatMap((m) =>
      m.epgId !== null && m.epgId.trim() !== '' ? [epgKey(m.epgId)] : [],
    );
    const nameKeys = indices.flatMap((i) => (fingerprints[i] === '' ? [] : [nameKey(fingerprints[i] ?? '')]));
    const key = dominant(epgKeys) ?? dominant(nameKeys) ?? `s:${refKey(first)}`;
    add(key, members);
  }

  // Corrections manuelles, appliquées en dernier : elles l'emportent sur tout.
  if (overrides.size === 0) return groups;
  for (const entry of entries) {
    const target = overrides.get(refKey(entry));
    if (target === undefined) continue;
    if (target === MERGE_SOLO) {
      add(`s:${refKey(entry)}`, [entry]);
      continue;
    }
    const group = byKey.get(target);
    if (group === undefined) add(target, [entry]);
    else group.members.push(entry);
  }
  return groups;
}

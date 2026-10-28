import { createHash } from 'node:crypto';
import {
  type ChannelGroup,
  type GridVerdict,
  type MergeEntry,
  displayName,
  mergeChannels,
  normalizeName,
  pairKey,
  refKey,
} from '@lumen/core/catalog';
import {
  ALL_PORTALS_ID,
  type ChannelDto,
  type ChannelListDto,
  type ChannelRef,
  type GenreDto,
  type MergeSettingsDto,
} from '@lumen/protocol';
import type { CatalogStore, StoredChannel } from '../store/catalog-store.js';
import type { MergeStore } from '../store/merge-store.js';
import { logoPath } from './catalog-service.js';

const VERSION_HEX_LENGTH = 20;
/** Un avis de grille est revérifié au bout d'une semaine : les grilles des portails évoluent. */
export const GRID_VERDICT_TTL_MS = 7 * 24 * 3_600_000;

interface MergedEntry extends MergeEntry {
  channel: StoredChannel;
}

type Group = ChannelGroup<MergedEntry>;

interface Built {
  signature: string;
  version: string;
  syncedAt: number;
  groups: Group[];
  byKey: Map<string, Group>;
  byRef: Map<string, Group>;
  /** Genre d'une chaîne (portail:genre) → genre fusionné. */
  genreOf: Map<string, string>;
  genres: GenreDto[];
  list: ChannelListDto | null;
}

/** Genres de même intitulé (« FR | Sport », « Sport ») : un seul genre dans la vue fusionnée. */
const mergedGenreId = (title: string): string => `g:${normalizeName(title)}`;

/** Le nom le plus lisible : on préfère une écriture en casse mixte aux noms tout en capitales. */
function bestName(members: readonly MergedEntry[]): string {
  const names = members.map((m) => displayName(m.channel.name));
  return names.find((n) => n !== n.toUpperCase()) ?? names[0] ?? '';
}

/**
 * Catalogue fusionné de tous les portails (vue « Tous les portails ») : une entrée par
 * chaîne, avec ses sources. Recalculé seulement quand un catalogue, une correction ou un
 * refus de grille change ; le reste du temps, servi depuis la mémoire.
 */
export class MergeService {
  private memo: Built | null = null;

  constructor(
    private readonly store: MergeStore,
    private readonly catalogs: CatalogStore,
  ) {}

  enabled(): boolean {
    return this.store.enabled();
  }

  settings(): MergeSettingsDto {
    return { enabled: this.store.enabled(), overrides: this.store.overrides() };
  }

  private signature(portals: readonly string[]): string {
    const metas = portals.map((id) => {
      const meta = this.catalogs.meta(id);
      return [id, meta?.version ?? '', meta?.syncedAt ?? 0];
    });
    return JSON.stringify([metas, this.store.revision]);
  }

  private built(): Built {
    const portals = this.catalogs.syncedPortals();
    const signature = this.signature(portals);
    if (this.memo?.signature === signature) return this.memo;

    const entries: MergedEntry[] = [];
    const genreOf = new Map<string, string>();
    const genres = new Map<string, GenreDto>();
    let syncedAt = 0;
    for (const portalId of portals) {
      const meta = this.catalogs.meta(portalId);
      syncedAt = Math.max(syncedAt, meta?.syncedAt ?? 0);
      for (const g of meta?.genres ?? []) {
        const id = mergedGenreId(g.title);
        genreOf.set(`${portalId}:${g.id}`, id);
        const known = genres.get(id);
        if (known === undefined) genres.set(id, { id, title: g.title, censored: g.censored });
        else if (g.censored) known.censored = true;
      }
      for (const channel of this.catalogs.channels(portalId)) {
        entries.push({
          portalId,
          channelId: channel.id,
          name: channel.name,
          epgId: channel.epgId,
          ...(channel.fingerprint === undefined ? {} : { fingerprint: channel.fingerprint }),
          channel,
        });
      }
    }
    const verdicts = new Map<string, GridVerdict>();
    for (const [pair, v] of this.store.verdicts()) if (v.verdict !== null) verdicts.set(pair, v.verdict);
    const overrides = new Map(this.store.overrides().map((o) => [refKey(o), o.target]));
    const groups = mergeChannels(entries, { verdicts, overrides });

    const byKey = new Map<string, Group>();
    const byRef = new Map<string, Group>();
    for (const group of groups) {
      byKey.set(group.key, group);
      for (const m of group.members) byRef.set(refKey(m), group);
    }
    this.memo = {
      signature,
      version: createHash('sha256').update(signature).digest('hex').slice(0, VERSION_HEX_LENGTH),
      syncedAt,
      groups,
      byKey,
      byRef,
      genreOf,
      genres: [...genres.values()],
      list: null,
    };
    return this.memo;
  }

  list(): ChannelListDto {
    const built = this.built();
    built.list ??= {
      portalId: ALL_PORTALS_ID,
      version: built.version,
      syncedAt: built.syncedAt,
      channels: built.groups.map((g, i) => this.toDto(built, g, i + 1)),
    };
    return built.list;
  }

  private toDto(built: Built, group: Group, number: number): ChannelDto {
    const first = group.members[0];
    const withLogo = group.members.find((m) => m.channel.logo !== null);
    const withEpg = group.members.find((m) => m.channel.epgId !== null);
    return {
      id: group.key,
      name: bestName(group.members),
      number,
      genreId:
        first === undefined ? '' : (built.genreOf.get(`${first.portalId}:${first.channel.genreId}`) ?? ''),
      logo: withLogo === undefined ? null : logoPath(withLogo.portalId, withLogo.channelId),
      epgId: withEpg?.channel.epgId ?? null,
      archiveHours: Math.max(0, ...group.members.map((m) => m.channel.archiveHours)),
      // Prudence : une seule source marquée « adulte » suffit à masquer la chaîne.
      censored: group.members.some((m) => m.channel.censored),
      sources: group.members.map((m) => ({
        portalId: m.portalId,
        channelId: m.channelId,
        name: m.channel.name,
      })),
    };
  }

  genres(): GenreDto[] {
    return this.built().genres;
  }

  /** Sources d'une chaîne fusionnée, dans l'ordre du catalogue ; null si la clé est inconnue. */
  members(groupKey: string): ChannelRef[] | null {
    const group = this.built().byKey.get(groupKey);
    return group === undefined
      ? null
      : group.members.map((m) => ({ portalId: m.portalId, channelId: m.channelId }));
  }

  /** Chaîne fusionnée d'une source (sa clé), null si la source est inconnue. */
  groupKeyOf(ref: ChannelRef): string | null {
    return this.built().byRef.get(refKey(ref))?.key ?? null;
  }

  /** La source qui porte le programme (identifiant EPG) d'une chaîne fusionnée. */
  epgSource(groupKey: string): ChannelRef | null {
    const group = this.built().byKey.get(groupKey);
    const member = group?.members.find((m) => m.channel.epgId !== null) ?? group?.members[0];
    return member === undefined ? null : { portalId: member.portalId, channelId: member.channelId };
  }

  /**
   * Paires à confirmer par la grille EPG : chaque source rapprochée d'un autre portail,
   * comparée à la première source de son groupe ; plus les refus anciens, revérifiés.
   */
  pendingGridChecks(now: number): [ChannelRef, ChannelRef][] {
    const built = this.built();
    const verdicts = this.store.verdicts();
    const fresh = (pair: string): boolean => {
      const v = verdicts.get(pair);
      return v !== undefined && now - v.checkedAt < GRID_VERDICT_TTL_MS;
    };
    const pending: [ChannelRef, ChannelRef][] = [];
    for (const group of built.groups) {
      const anchor = group.members[0];
      if (anchor === undefined) continue;
      for (const m of group.members.slice(1)) {
        if (m.portalId !== anchor.portalId && !fresh(pairKey(anchor, m))) pending.push([anchor, m]);
      }
    }
    for (const [pair, v] of verdicts) {
      if (v.verdict !== 'different' || fresh(pair)) continue;
      const [a, b] = pair.split('|').map((k) => built.byRef.get(k)?.members.find((m) => refKey(m) === k));
      if (a !== undefined && b !== undefined) pending.push([a, b]);
    }
    return pending.map(([a, b]) => [
      { portalId: a.portalId, channelId: a.channelId },
      { portalId: b.portalId, channelId: b.channelId },
    ]);
  }
}

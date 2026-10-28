import type { GridProgramme } from '@lumen/core/catalog';
import type { ChannelRef } from '@lumen/protocol';
import { describe, expect, it } from 'vitest';
import { GridChecker } from '../src/catalog/grid-checker.js';
import { MergeService } from '../src/catalog/merge-service.js';
import { CatalogStore, type StoredChannel } from '../src/store/catalog-store.js';
import { openDatabase } from '../src/store/database.js';
import { MergeStore } from '../src/store/merge-store.js';

const HOUR = 3_600_000;
// 28 octobre 2026, 3 h heure locale : dans la fenêtre nocturne.
const NIGHT = new Date(2026, 9, 28, 3, 0).getTime();
const EVENING = new Date(2026, 9, 27, 20, 0).getTime();

const channel = (id: string, name: string, epgId: string | null = null): StoredChannel => ({
  id,
  name,
  number: Number(id),
  genreId: '1',
  logo: null,
  epgId,
  archiveHours: 0,
  censored: false,
  cmd: `ffmpeg http://localhost/ch/${id}`,
});

function setup(portals: Record<string, StoredChannel[]>) {
  const db = openDatabase(':memory:');
  const catalogs = new CatalogStore(db);
  const store = new MergeStore(db);
  let created = 0;
  for (const [id, channels] of Object.entries(portals)) {
    db.prepare('INSERT INTO portals (id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      id,
      Buffer.alloc(1),
      created++,
    );
    catalogs.replace(id, channels, [{ id: '1', title: 'FR | Sport', censored: false }], `v-${id}`, 1);
  }
  return { db, catalogs, store, merge: new MergeService(store, catalogs) };
}

describe('catalogue fusionné (vue « Tous les portails »)', () => {
  it('une entrée par chaîne, avec ses sources, un nom propre et un genre commun', () => {
    const { merge } = setup({
      A: [channel('1', 'FR | NOVA TV FHD', 'nova.fr'), channel('2', 'FR | SUN INFO HD')],
      B: [channel('7', 'Nova TV France 1080'), channel('8', 'Sun Info Sénégal', 'sun.sn')],
    });
    const list = merge.list();
    expect(list.portalId).toBe('all');
    expect(list.channels.map((c) => [c.name, c.sources?.map((s) => `${s.portalId}:${s.channelId}`)])).toEqual(
      [
        ['Nova TV France', ['A:1', 'B:7']],
        ['Sun Info Sénégal', ['A:2', 'B:8']],
      ],
    );
    expect(list.channels.map((c) => c.number)).toEqual([1, 2]);
    expect(list.channels[1]!.epgId).toBe('sun.sn');
    expect(merge.genres()).toEqual([{ id: 'g:sport', title: 'FR | Sport', censored: false }]);
    expect(new Set(list.channels.map((c) => c.genreId))).toEqual(new Set(['g:sport']));
  });

  it('correction manuelle : la liste change de version et la chaîne est mise à part', () => {
    const { merge, store } = setup({ A: [channel('1', 'Nova TV')], B: [channel('7', 'Nova TV')] });
    const before = merge.list();
    store.setOverride('B', '7', 'solo', 1);
    const after = merge.list();
    expect(after.version).not.toBe(before.version);
    expect(after.channels).toHaveLength(2);
    expect(merge.groupKeyOf({ portalId: 'B', channelId: '7' })).toBe('s:B:7');
  });

  it('source d une chaîne fusionnée retrouvée depuis n importe laquelle de ses sources', () => {
    const { merge } = setup({ A: [channel('1', 'Nova TV')], B: [channel('7', 'Nova TV')] });
    const key = merge.groupKeyOf({ portalId: 'B', channelId: '7' });
    expect(key).toBe('n:nova tv');
    expect(merge.members(key ?? '')).toEqual([
      { portalId: 'A', channelId: '1' },
      { portalId: 'B', channelId: '7' },
    ]);
    expect(merge.members('inconnue')).toBeNull();
  });
});

const H = HOUR;
const grid = (titles: string[], from: number): GridProgramme[] =>
  titles.map((title, i) => ({ title, start: from + i * H, end: from + (i + 1) * H }));
const SIX = ['Journal', 'Météo', 'Série', 'Film', 'Débat', 'Journal du soir'];

function checker(
  merge: MergeService,
  store: MergeStore,
  grids: Record<string, string[]>,
  busy = new Set<string>(),
) {
  const fetched: string[] = [];
  const c = new GridChecker(
    { perHour: 600, startHour: 3, endHour: 6 },
    {
      merge,
      store,
      grid: (ref: ChannelRef, from: number) => {
        fetched.push(`${ref.portalId}:${ref.channelId}`);
        return Promise.resolve(grid(grids[`${ref.portalId}:${ref.channelId}`] ?? [], from));
      },
      portalBusy: (portalId) => busy.has(portalId),
    },
  );
  return { c, fetched };
}

describe('confirmation des rapprochements par la grille EPG (6 h)', () => {
  it('grilles différentes : le rapprochement est défait', async () => {
    const { merge, store } = setup({ A: [channel('1', 'Nova TV')], B: [channel('7', 'Nova TV')] });
    const { c } = checker(merge, store, { 'A:1': SIX, 'B:7': ['A', 'B', 'C', 'D', 'E', 'F'] });
    expect(await c.checkNext(NIGHT)).toBe('checked');
    expect(merge.list().channels).toHaveLength(2);
  });

  it('grilles identiques : confirmé, et pas revérifié avant une semaine', async () => {
    const { merge, store } = setup({ A: [channel('1', 'Nova TV')], B: [channel('7', 'Nova TV')] });
    const { c, fetched } = checker(merge, store, { 'A:1': SIX, 'B:7': SIX });
    expect(await c.checkNext(NIGHT)).toBe('checked');
    expect(merge.list().channels).toHaveLength(1);
    expect(fetched).toEqual(['A:1', 'B:7']);
    expect(await c.checkNext(NIGHT + HOUR)).toBe('idle');
  });

  it('jamais en journée, ni sur un portail où quelqu un regarde', async () => {
    const { merge, store } = setup({ A: [channel('1', 'Nova TV')], B: [channel('7', 'Nova TV')] });
    expect(await checker(merge, store, {}).c.checkNext(EVENING)).toBe('idle');
    const busy = checker(merge, store, {}, new Set(['B']));
    expect(await busy.c.checkNext(NIGHT)).toBe('idle');
    expect(busy.fetched).toEqual([]);
  });

  it('grille indisponible : aucun avis, la fusion reste telle quelle', async () => {
    const { merge, store } = setup({ A: [channel('1', 'Nova TV')], B: [channel('7', 'Nova TV')] });
    const { c } = checker(merge, store, { 'A:1': SIX });
    expect(await c.checkNext(NIGHT)).toBe('checked');
    expect(merge.list().channels).toHaveLength(1);
  });
});

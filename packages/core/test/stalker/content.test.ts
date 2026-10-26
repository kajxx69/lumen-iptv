import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, TEST_MAC, collect, firstBytes, harness } from './helpers.js';

const HOUR = 3_600_000;

describe('client Stalker : EPG, VOD, séries, radio, archive, favoris, compte', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await h.client.authenticate();
  });
  afterAll(async () => h.close());

  describe('EPG', () => {
    it('get_short_epg : programmes contigus à partir de l en-cours', async () => {
      const now = Date.now();
      const epg = await h.client.getShortEpg('1', 5);
      expect(epg).toHaveLength(5);
      expect(epg[0]!.start).toBeLessThanOrEqual(now);
      expect(epg[0]!.end).toBeGreaterThan(now);
      for (let i = 1; i < epg.length; i++) expect(epg[i]!.start).toBe(epg[i - 1]!.end);
      expect(epg.every((p) => p.channelId === '1' && p.name !== '')).toBe(true);
    });

    it('get_epg_info : grille groupée par chaîne', async () => {
      const grid = await h.client.getEpgInfo(2);
      expect(grid.size).toBe(5000);
      expect(grid.get('10')?.length).toBeGreaterThan(0);
    });

    it('get_data_table : page de chaînes avec leur grille', async () => {
      const page = await h.client.getDataTable({ page: 1, from: Date.now(), to: Date.now() + 6 * HOUR });
      expect(page.items).toHaveLength(14);
      expect(page.items[0]!.programmes.length).toBeGreaterThan(0);
    });

    it('getEpg : couvre une fenêtre à cheval sur minuit, sans trou ni doublon', async () => {
      const midnight = Math.floor(Date.now() / (24 * HOUR)) * 24 * HOUR + 24 * HOUR;
      const window = { from: midnight - 3 * HOUR, to: midnight + 3 * HOUR };
      const epg = await h.client.getEpg('7', window);
      expect(epg[0]!.start).toBeLessThanOrEqual(window.from);
      expect(epg.at(-1)!.end).toBeGreaterThanOrEqual(window.to);
      for (let i = 1; i < epg.length; i++) expect(epg[i]!.start).toBe(epg[i - 1]!.end);
      expect(new Set(epg.map((p) => p.id)).size).toBe(epg.length);
    });
  });

  describe('VOD', () => {
    it('catégories, liste paginée, recherche', async () => {
      const categories = await h.client.getVodCategories();
      expect(categories.length).toBeGreaterThan(1);
      const page = await h.client.getVodPage({ category: '*', page: 1 });
      expect(page.totalItems).toBe(1500);
      const term = page.items[0]!.name.split(' ').at(-1)!;
      const found = await collect(h.client.listVod({ search: term }));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((m) => m.name.toLowerCase().includes(term.toLowerCase()))).toBe(true);
    });

    it('fiche normalisée', async () => {
      const [movie] = (await h.client.getVodPage({ page: 1 })).items;
      expect(movie).toMatchObject({
        id: expect.any(String),
        year: expect.any(Number),
        durationMin: expect.any(Number),
      });
      expect(movie!.poster).toMatch(/^http/);
    });

    it('create_link : lien lisible', async () => {
      const [movie] = (await h.client.getVodPage({ page: 1 })).items;
      const link = await h.client.createVodLink(movie!.cmd);
      const { status, bytes } = await firstBytes(link.url);
      expect(status).toBe(200);
      expect(bytes[0]).toBe(0x47);
    });
  });

  describe('séries', () => {
    it('séries → saisons → épisodes → lien', async () => {
      const [series] = (await h.client.getSeriesPage({ page: 1 })).items;
      const seasons = await h.client.getSeasons(series!.id);
      expect(seasons.length).toBeGreaterThan(0);
      expect(seasons[0]).toMatchObject({ number: 1 });
      const episodes = await h.client.getEpisodes(series!.id, seasons[0]!.id);
      expect(episodes).toHaveLength(seasons[0]!.episodeCount);
      expect(episodes.map((e) => e.number)).toEqual(Array.from({ length: episodes.length }, (_, i) => i + 1));
      const link = await h.client.createEpisodeLink(episodes[0]!.cmd);
      expect((await firstBytes(link.url)).bytes[0]).toBe(0x47);
    });

    it('catégories de séries', async () => {
      expect((await h.client.getSeriesCategories()).length).toBeGreaterThan(1);
    });
  });

  describe('radio', () => {
    it('genres, liste et lien', async () => {
      expect((await h.client.getRadioGenres()).length).toBeGreaterThan(1);
      const stations = await collect(h.client.listRadio());
      expect(stations).toHaveLength(200);
      const link = await h.client.createRadioLink(stations[0]!.cmd);
      expect(link.url).toMatch(/^http/);
    });
  });

  describe('archive (catch-up)', () => {
    it('create_link horodaté sur un programme passé archivé', async () => {
      const channel = (await h.client.getAllChannels()).find((c) => c.archive)!;
      const epg = await h.client.getEpg(channel.id, { from: Date.now() - 6 * HOUR, to: Date.now() - HOUR });
      const past = epg.find((p) => p.archived)!;
      expect(past.cmd).not.toBe('');
      const link = await h.client.createArchiveLink(past.cmd);
      const { status, bytes } = await firstBytes(link.url);
      expect(status).toBe(200);
      expect(bytes[0]).toBe(0x47);
    });
  });

  describe('favoris', () => {
    it('set_fav puis get_fav_items et ids', async () => {
      await h.client.setFavorites(['5', '2', '9']);
      expect(await h.client.getFavoriteIds()).toEqual(['5', '2', '9']);
      expect((await collect(h.client.listFavorites())).map((c) => c.id)).toEqual(['5', '2', '9']);
      await h.client.setFavorites([]);
      expect(await h.client.getFavoriteIds()).toEqual([]);
    });
  });

  describe('compte', () => {
    it('get_profile, get_account_info, get_main_info', async () => {
      expect((await h.client.getProfile()).status).toBe(0);
      expect(await h.client.getAccountInfo()).toMatchObject({ mac: TEST_MAC });
      const main = await h.client.getMainInfo();
      expect(main.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});

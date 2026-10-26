import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTRYPOINT,
  MAG250_UA,
  type RunningPortal,
  StalkerTestClient,
  TEST_MAC,
  TsCapture,
  chaos,
  delay,
  startPortal,
  stripPrefix,
} from './helpers.js';

interface Page<T> {
  total_items: string;
  max_page_items: string;
  cur_page: string;
  data: T[];
}
interface ChannelJson {
  id: string;
  name: string;
  cmd: string;
  logo: string;
  tv_genre_id: string;
  tv_archive: string;
}
interface ProgrammeJson {
  id: string;
  start_timestamp: string;
  stop_timestamp: string;
  mark_archive: string;
  cmd: string;
}

describe('protocole Stalker', () => {
  let portal: RunningPortal;
  let client: StalkerTestClient;

  beforeAll(async () => {
    portal = await startPortal({ apiRateLimitPerSecond: 10_000 });
  });
  afterAll(async () => portal.close());
  beforeEach(async () => {
    await chaos(portal.baseUrl, 'reset');
    client = new StalkerTestClient(portal.baseUrl);
    await client.handshake();
  });

  describe('authentification', () => {
    it('handshake renvoie un token puis get_profile décrit un compte actif', async () => {
      expect(client.token).toMatch(/^[0-9A-F]{32}$/);
      const profile = await client.call<Record<string, unknown>>('stb', 'get_profile', {
        hd: 1,
        ver: 'ImageDescription: 0.2.18-r23-250',
      });
      expect(profile).toMatchObject({ status: '0', mac: TEST_MAC, stb_type: 'MAG250' });
      expect(profile['expire_billing_date']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('refuse un appareil qui ne se présente pas comme un MAG', async () => {
      const res = await fetch(`${portal.baseUrl}${DEFAULT_ENTRYPOINT}?type=stb&action=handshake`, {
        headers: {
          Cookie: `mac=${encodeURIComponent(TEST_MAC)}`,
          'User-Agent': 'curl/8',
          'X-User-Agent': 'Model: MAG250',
        },
      });
      expect(res.status).toBe(403);
    });

    it('refuse un modèle non autorisé et une MAC invalide', async () => {
      expect(
        (
          await new StalkerTestClient(portal.baseUrl, TEST_MAC, 'MAG999').raw({
            type: 'stb',
            action: 'handshake',
          })
        ).status,
      ).toBe(403);
      expect(
        (await new StalkerTestClient(portal.baseUrl, 'pas-une-mac').raw({ type: 'stb', action: 'handshake' }))
          .status,
      ).toBe(403);
    });

    it('exige le token Bearer, lié à la MAC du handshake', async () => {
      const anonymous = new StalkerTestClient(portal.baseUrl);
      expect((await anonymous.raw({ type: 'stb', action: 'get_profile' })).status).toBe(401);
      const otherMac = new StalkerTestClient(portal.baseUrl, '00:1A:79:00:00:02');
      otherMac.token = client.token;
      expect((await otherMac.raw({ type: 'stb', action: 'get_profile' })).status).toBe(401);
    });

    it('répond sur tous les points d entrée configurés', async () => {
      for (const entrypoint of ['/server/load.php', '/portal.php', '/c/portal.php']) {
        const c = new StalkerTestClient(portal.baseUrl, TEST_MAC, 'MAG250', entrypoint);
        await expect(c.handshake()).resolves.toMatch(/^[0-9A-F]+$/);
      }
    });

    it('sert les en-têtes au type de contenu des vrais portails', async () => {
      const res = await fetch(`${portal.baseUrl}${DEFAULT_ENTRYPOINT}?type=stb&action=handshake`, {
        headers: client.headers(),
      });
      expect(res.headers.get('content-type')).toContain('text/javascript');
    });
  });

  describe('do_auth requis', () => {
    let authPortal: RunningPortal;
    beforeAll(async () => {
      authPortal = await startPortal({
        requireDoAuth: true,
        login: 'demo',
        password: 'demo',
        entrypoints: ['/portal.php'],
      });
    });
    afterAll(async () => authPortal.close());

    it('get_profile signale status=2, puis do_auth débloque le compte', async () => {
      const c = new StalkerTestClient(authPortal.baseUrl, TEST_MAC, 'MAG250', '/portal.php');
      await c.handshake();
      expect(await c.call('stb', 'get_profile')).toMatchObject({ status: '2' });
      expect((await c.raw({ type: 'itv', action: 'get_genres' })).status).toBe(403);
      expect(await c.call('stb', 'do_auth', { login: 'demo', password: 'faux' })).toBe(false);
      expect(await c.call('stb', 'do_auth', { login: 'demo', password: 'demo' })).toBe(true);
      expect(await c.call('stb', 'get_profile')).toMatchObject({ status: '0' });
      expect(await c.call<unknown[]>('itv', 'get_genres')).not.toHaveLength(0);
    });

    it('n expose que le point d entrée configuré', async () => {
      const c = new StalkerTestClient(authPortal.baseUrl);
      expect((await c.raw({ type: 'stb', action: 'handshake' }).catch(() => ({ status: 404 }))).status).toBe(
        404,
      );
    });
  });

  describe('limitation de débit', () => {
    it('bannit la MAC au-delà du seuil par seconde', async () => {
      const strict = await startPortal({ apiRateLimitPerSecond: 5, macBanDurationMs: 60_000 });
      try {
        const c = new StalkerTestClient(strict.baseUrl);
        await c.handshake();
        const statuses = await Promise.all(
          Array.from({ length: 12 }, () =>
            c.raw({ type: 'stb', action: 'get_profile' }).then((r) => r.status),
          ),
        );
        expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
        // Le bannissement persiste au-delà de la fenêtre d'une seconde.
        await delay(1100);
        expect((await c.raw({ type: 'stb', action: 'get_profile' })).status).toBe(429);
      } finally {
        await strict.close();
      }
    });
  });

  describe('TV', () => {
    it('get_genres liste la catégorie « tout » et les genres', async () => {
      const genres = await client.call<{ id: string; title: string }[]>('itv', 'get_genres');
      expect(genres[0]).toMatchObject({ id: '*' });
      expect(genres.length).toBeGreaterThan(10);
    });

    it('get_all_channels renvoie les 5 000 chaînes', async () => {
      const js = await client.call<Page<ChannelJson>>('itv', 'get_all_channels');
      expect(js.total_items).toBe('5000');
      expect(js.data).toHaveLength(5000);
      expect(new Set(js.data.map((c) => c.id)).size).toBe(5000);
    });

    it('get_ordered_list est paginé par 14, total cohérent', async () => {
      const first = await client.call<Page<ChannelJson>>('itv', 'get_ordered_list', {
        genre: '*',
        p: 1,
        sortby: 'number',
      });
      expect(first.total_items).toBe('5000');
      expect(first.max_page_items).toBe('14');
      expect(first.data).toHaveLength(14);
      const lastPage = Math.ceil(5000 / 14);
      const last = await client.call<Page<ChannelJson>>('itv', 'get_ordered_list', {
        genre: '*',
        p: lastPage,
      });
      expect(last.data).toHaveLength(5000 - (lastPage - 1) * 14);
      const beyond = await client.call<Page<ChannelJson>>('itv', 'get_ordered_list', {
        genre: '*',
        p: lastPage + 1,
      });
      expect(beyond.data).toHaveLength(0);
    });

    it('filtre par genre', async () => {
      const page = await client.call<Page<ChannelJson>>('itv', 'get_ordered_list', { genre: '3', p: 1 });
      expect(Number(page.total_items)).toBeGreaterThan(0);
      expect(page.data.every((c) => c.tv_genre_id === '3')).toBe(true);
    });

    it('expose des cas dégradés réalistes : logos absents ou cassés, préfixes variés', async () => {
      const { data } = await client.call<Page<ChannelJson>>('itv', 'get_all_channels');
      expect(data.some((c) => c.logo === '')).toBe(true);
      const broken = data.find((c) => c.logo.includes('missing'));
      expect(broken).toBeDefined();
      expect((await fetch(broken!.logo)).status).toBe(404);
      const fine = data.find((c) => c.logo !== '' && !c.logo.includes('missing'));
      expect((await fetch(fine!.logo)).headers.get('content-type')).toBe('image/png');
    });

    it('create_link renvoie une URL éphémère avec préfixe parasite, lisible une seule fois', async () => {
      const raw = await client.call<{ cmd: string; error: string }>('itv', 'create_link', {
        cmd: 'ffmpeg http://localhost/ch/1_',
      });
      expect(raw.error).toBe('');
      expect(raw.cmd).toMatch(/^(ffmpeg |auto )?http:\/\/.+\/play\/live\.php\?.*play_token=/);
      const url = stripPrefix(raw.cmd);
      const capture = await TsCapture.open(url);
      expect(capture.status).toBe(200);
      await delay(500);
      expect(capture.bytes).toBeGreaterThan(0);
      expect(capture.syncErrors).toBe(0);
      capture.close();
      // Une reconnexion avec la même URL échoue : il faut un nouveau create_link.
      const again = await TsCapture.open(url);
      expect(again.status).toBe(403);
      again.close();
    });

    it('les préfixes de create_link varient selon les chaînes', async () => {
      const prefixes = new Set<string>();
      for (let id = 1; id <= 30; id++) {
        const { cmd } = await client.call<{ cmd: string }>('itv', 'create_link', {
          cmd: `ffmpeg http://localhost/ch/${id}_`,
        });
        prefixes.add(/^(ffmpeg |auto )/.exec(cmd)?.[1] ?? '');
      }
      expect(prefixes).toEqual(new Set(['ffmpeg ', 'auto ', '']));
    });

    it('une URL non utilisée expire après playTokenTtlMs', async () => {
      const shortTtl = await startPortal({ playTokenTtlMs: 300 });
      try {
        const c = new StalkerTestClient(shortTtl.baseUrl);
        await c.handshake();
        const url = await c.liveUrl(1);
        await delay(500);
        const capture = await TsCapture.open(url);
        expect(capture.status).toBe(403);
        capture.close();
      } finally {
        await shortTtl.close();
      }
    });

    it('nothing_to_play pour une chaîne inconnue', async () => {
      expect(
        await client.call('itv', 'create_link', { cmd: 'ffmpeg http://localhost/ch/999999_' }),
      ).toMatchObject({ error: 'nothing_to_play' });
    });

    it('sert un HLS live à fenêtre glissante quand streamFormat=m3u8', async () => {
      const hls = await startPortal({ streamFormat: 'm3u8' });
      try {
        const c = new StalkerTestClient(hls.baseUrl);
        await c.handshake();
        const url = await c.liveUrl(1);
        expect(url).toContain('extension=m3u8');
        const playlist = await (await fetch(url)).text();
        expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:');
        const segments = playlist.split('\n').filter((l) => l.startsWith('/hls/'));
        expect(segments).toHaveLength(6);
        const seg = await fetch(`${hls.baseUrl}${segments.at(-1)!}`);
        expect(seg.status).toBe(200);
        const body = Buffer.from(await seg.arrayBuffer());
        expect(body.length % 188).toBe(0);
        expect(body[0]).toBe(0x47);
        // Le même lien sert la playlist suivante : HLS réutilise le token tant que la session vit.
        expect((await fetch(url)).status).toBe(200);
      } finally {
        await hls.close();
      }
    });
  });

  describe('EPG', () => {
    it('get_short_epg renvoie les programmes à partir de l en-cours', async () => {
      const epg = await client.call<ProgrammeJson[]>('itv', 'get_short_epg', { ch_id: 1, size: 5 });
      expect(epg).toHaveLength(5);
      const now = Date.now() / 1000;
      expect(Number(epg[0]!.start_timestamp)).toBeLessThanOrEqual(now);
      expect(Number(epg[0]!.stop_timestamp)).toBeGreaterThan(now);
      for (let i = 1; i < epg.length; i++) expect(epg[i]!.start_timestamp).toBe(epg[i - 1]!.stop_timestamp);
    });

    it('get_epg_info couvre toutes les chaînes sur la période', async () => {
      const js = await client.call<{ data: Record<string, ProgrammeJson[]> }>('itv', 'get_epg_info', {
        period: 2,
      });
      expect(Object.keys(js.data)).toHaveLength(5000);
      expect(js.data['1']!.length).toBeGreaterThan(0);
    });

    it('get_data_table pagine les chaînes avec leur grille', async () => {
      const js = await client.call<Page<{ ch_id: string; epg: ProgrammeJson[] }>>('epg', 'get_data_table', {
        p: 2,
      });
      expect(js.data).toHaveLength(14);
      expect(js.data[0]!.epg.length).toBeGreaterThan(0);
    });

    it('la même chaîne a la même grille sur deux portails (signal de dédoublonnage)', async () => {
      const other = await startPortal({ seed: 2, namingStyle: 'plain' });
      try {
        const c = new StalkerTestClient(other.baseUrl);
        await c.handshake();
        const a = await client.call<ProgrammeJson[]>('itv', 'get_short_epg', { ch_id: 10, size: 4 });
        const b = await c.call<ProgrammeJson[]>('itv', 'get_short_epg', { ch_id: 100_010, size: 4 });
        expect(b.map((p) => p.start_timestamp)).toEqual(a.map((p) => p.start_timestamp));
        const nameA = (await client.call<Page<ChannelJson>>('itv', 'get_ordered_list', { p: 1 })).data[0]!
          .name;
        const nameB = (await c.call<Page<ChannelJson>>('itv', 'get_ordered_list', { p: 1 })).data[0]!.name;
        expect(nameA).not.toBe(nameB);
      } finally {
        await other.close();
      }
    });
  });

  describe('VOD, séries, radio, archive, favoris, compte', () => {
    it('VOD : catégories, liste paginée, recherche, create_link lisible', async () => {
      const cats = await client.call<{ id: string }[]>('vod', 'get_categories');
      expect(cats.length).toBeGreaterThan(1);
      const list = await client.call<Page<{ id: string; name: string; cmd: string }>>(
        'vod',
        'get_ordered_list',
        { category: '*', p: 1 },
      );
      expect(list.total_items).toBe('1500');
      const term = list.data[0]!.name.split(' ').at(-1)!;
      const found = await client.call<Page<{ name: string }>>('vod', 'get_ordered_list', {
        category: '*',
        search: term,
        p: 1,
      });
      expect(found.data.every((m) => m.name.toLowerCase().includes(term.toLowerCase()))).toBe(true);
      const link = await client.call<{ cmd: string }>('vod', 'create_link', { cmd: list.data[0]!.cmd });
      const res = await fetch(stripPrefix(link.cmd), { headers: { Range: 'bytes=0-1879' } });
      expect(res.status).toBe(206);
      expect(Buffer.from(await res.arrayBuffer())).toHaveLength(1880);
    });

    it('séries : saisons puis épisodes, puis create_link', async () => {
      const series = await client.call<Page<{ id: string }>>('series', 'get_ordered_list', {
        category: '*',
        p: 1,
      });
      const id = series.data[0]!.id;
      const seasons = await client.call<Page<{ id: string; series: number[] }>>(
        'series',
        'get_ordered_list',
        { movie_id: id, p: 1 },
      );
      expect(seasons.data.length).toBeGreaterThan(0);
      const episodes = await client.call<Page<{ cmd: string }>>('series', 'get_ordered_list', {
        movie_id: id,
        season_id: seasons.data[0]!.id,
        p: 1,
      });
      expect(episodes.data).toHaveLength(Math.min(14, seasons.data[0]!.series.length));
      const link = await client.call<{ cmd: string; error: string }>('series', 'create_link', {
        cmd: episodes.data[0]!.cmd,
      });
      expect(link.error).toBe('');
    });

    it('radio : genres et liste', async () => {
      expect((await client.call<unknown[]>('radio', 'get_genres')).length).toBeGreaterThan(1);
      const list = await client.call<Page<{ cmd: string }>>('radio', 'get_ordered_list', { p: 1 });
      expect(list.total_items).toBe('200');
      expect(await client.call('radio', 'create_link', { cmd: list.data[0]!.cmd })).toMatchObject({
        error: '',
      });
    });

    it('archive : create_link horodaté pour un programme passé, refus hors fenêtre', async () => {
      const { data } = await client.call<Page<ChannelJson>>('itv', 'get_all_channels');
      const channel = data.find((c) => c.tv_archive === '1')!;
      const yesterday = Math.floor(Date.now() / 1000) - 6 * 3600;
      const table = await client.call<Page<ProgrammeJson>>('epg', 'get_simple_data_table', {
        ch_id: channel.id,
        date: new Date(yesterday * 1000).toISOString().slice(0, 10),
        p: 1,
      });
      const past = table.data.find((p) => p.mark_archive === '1');
      expect(past).toBeDefined();
      const link = await client.call<{ cmd: string; error: string }>('tv_archive', 'create_link', {
        cmd: past!.cmd,
      });
      expect(link.error).toBe('');
      const capture = await TsCapture.open(stripPrefix(link.cmd));
      await delay(300);
      expect(capture.video.length).toBeGreaterThan(0);
      capture.close();
      const future = `auto /media/${channel.id}_${Math.floor(Date.now() / 1000) + 3600}_60.mpg`;
      expect(await client.call('tv_archive', 'create_link', { cmd: future })).toMatchObject({
        error: 'nothing_to_play',
      });
    });

    it('favoris : set_fav puis get_fav_ids et get_fav_items', async () => {
      expect(await client.call('itv', 'set_fav', { fav_ch: '3,1,2' })).toBe(true);
      expect(await client.call('itv', 'get_fav_ids')).toEqual(['3', '1', '2']);
      const items = await client.call<Page<ChannelJson>>('itv', 'get_fav_items', { p: 1 });
      expect(items.data.map((c) => c.id)).toEqual(['3', '1', '2']);
      const favOnly = await client.call<Page<ChannelJson>>('itv', 'get_ordered_list', { fav: 1, p: 1 });
      expect(favOnly.total_items).toBe('3');
    });

    it('compte : get_main_info et get_account_info', async () => {
      expect(await client.call('account_info', 'get_main_info')).toMatchObject({ mac: TEST_MAC });
      expect(await client.call('stb', 'get_account_info')).toMatchObject({ mac: TEST_MAC });
    });

    it('nombres en nombres quand stringNumbers=false (variante de portail)', async () => {
      const numeric = await startPortal({ stringNumbers: false, channelCount: 20 });
      try {
        const c = new StalkerTestClient(numeric.baseUrl);
        await c.handshake();
        const page = await c.call<{ total_items: unknown }>('itv', 'get_ordered_list', { p: 1 });
        expect(page.total_items).toBe(20);
      } finally {
        await numeric.close();
      }
    });
  });

  it('User-Agent de test conforme au MAG250 de PROJECT.md', () => {
    expect(MAG250_UA).toContain('MAG200 stbapp ver: 2 rev: 250');
  });
});

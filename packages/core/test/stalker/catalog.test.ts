import { afterEach, describe, expect, it } from 'vitest';
import { PaginationError, type StalkerChannel, StalkerError } from '../../stalker/index.js';
import { type Harness, collect, harness, sendChaos } from './helpers.js';

const ids = (channels: StalkerChannel[]): string[] => channels.map((c) => c.id);

describe('client Stalker : catalogue TV', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('get_genres : catégorie « tout » puis genres', async () => {
    h = await harness();
    const genres = await h.client.getGenres();
    expect(genres[0]).toMatchObject({ id: '*' });
    expect(genres.find((g) => g.censored)).toBeDefined();
  });

  it('get_all_channels : les 5 000 chaînes en une requête', async () => {
    h = await harness();
    const channels = await h.client.getAllChannels();
    expect(channels).toHaveLength(5000);
    expect(new Set(ids(channels)).size).toBe(5000);
    expect(channels[0]).toMatchObject({ id: '1', number: 1 });
  });

  it('get_ordered_list : une page de 14 avec le total', async () => {
    h = await harness();
    const page = await h.client.getOrderedList({ genre: '*', page: 2 });
    expect(page.totalItems).toBe(5000);
    expect(page.pageSize).toBe(14);
    expect(ids(page.items)[0]).toBe('15');
  });

  describe('listChannels', () => {
    it('stratégie auto : une seule requête quand get_all_channels répond', async () => {
      h = await harness();
      await h.client.authenticate();
      h.runtime.http.reset();
      expect(await collect(h.client.listChannels())).toHaveLength(5000);
      expect(h.runtime.http.requests.map((r) => r.action)).toEqual(['get_all_channels']);
    });

    it('stratégie auto : bascule sur la pagination quand get_all_channels est désactivé', async () => {
      h = await harness({ channelCount: 300, disabledActions: ['itv.get_all_channels'] });
      const channels = await collect(h.client.listChannels());
      expect(ids(channels)).toEqual(Array.from({ length: 300 }, (_, i) => String(i + 1)));
      expect(h.runtime.http.count('get_ordered_list')).toBe(Math.ceil(300 / 14));
    });

    it('pagination : au plus 4 requêtes simultanées, ordre préservé', async () => {
      h = await harness(
        { channelCount: 200, apiRateLimitPerSecond: 1000 },
        { tuning: { rateLimitPerSecond: 100 } },
      );
      await h.client.authenticate();
      await sendChaos(h.portal.baseUrl, 'latency', { ms: 300, scope: 'api' });
      h.runtime.http.reset();
      const channels = await collect(h.client.listChannels({ strategy: 'paged' }));
      expect(ids(channels)).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 1)));
      expect(h.runtime.http.maxInFlight).toBe(4);
    });

    it('filtre par genre', async () => {
      h = await harness({ channelCount: 400 });
      const sport = await collect(h.client.listChannels({ genre: '3' }));
      expect(sport.length).toBeGreaterThan(0);
      expect(sport.every((c) => c.genreId === '3')).toBe(true);
    });

    it('reprise sur échec : les erreurs passagères (503) sont réessayées sans perte ni doublon', async () => {
      h = await harness(
        { channelCount: 300, apiRateLimitPerSecond: 1000 },
        { tuning: { rateLimitPerSecond: 100 } },
      );
      await h.client.authenticate();
      await sendChaos(h.portal.baseUrl, 'http-error', { code: 503, probability: 0.3, scope: 'api', seed: 5 });
      const channels = await collect(h.client.listChannels({ strategy: 'paged' }));
      expect(ids(channels)).toEqual(Array.from({ length: 300 }, (_, i) => String(i + 1)));
      expect(h.runtime.http.requests.some((r) => r.status === 503)).toBe(true);
    });

    it('échec persistant : erreur typée indiquant la page de reprise, puis reprise sans doublon', async () => {
      h = await harness(
        { channelCount: 300, apiRateLimitPerSecond: 1000 },
        { tuning: { rateLimitPerSecond: 100 } },
      );
      const received: StalkerChannel[] = [];
      let failure: unknown;
      try {
        for await (const c of h.client.listChannels({ strategy: 'paged' })) {
          received.push(c);
          // Le portail tombe au milieu de la liste.
          if (received.length === 50)
            await sendChaos(h.portal.baseUrl, 'http-error', { code: 500, probability: 1, scope: 'api' });
        }
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(PaginationError);
      const pagination = failure as PaginationError;
      expect(pagination.kind).toBe('pagination_failed');
      expect(pagination.cause).toBeInstanceOf(StalkerError);
      expect(received).toHaveLength((pagination.resumeFromPage - 1) * 14);

      await sendChaos(h.portal.baseUrl, 'reset');
      for await (const c of h.client.listChannels({
        strategy: 'paged',
        startPage: pagination.resumeFromPage,
      }))
        received.push(c);
      expect(ids(received)).toEqual(Array.from({ length: 300 }, (_, i) => String(i + 1)));
    });
  });

  describe('variantes de portail', () => {
    it('réponses sans enveloppe js', async () => {
      h = await harness({ omitJsEnvelope: true, channelCount: 50 });
      await h.client.authenticate();
      expect(await h.client.getAllChannels()).toHaveLength(50);
      expect((await h.client.getOrderedList({ page: 1 })).totalItems).toBe(50);
    });

    it('nombres natifs au lieu de chaînes', async () => {
      h = await harness({ stringNumbers: false, channelCount: 50 });
      const channels = await h.client.getAllChannels();
      expect(channels[3]).toMatchObject({ id: '4', number: 4 });
    });
  });

  describe('débit vers le portail', () => {
    it('5 requêtes/s par défaut : jamais banni par un portail strict', async () => {
      // Le portail bannit au-delà de 6 req/s ; le client doit rester en dessous sans y penser.
      h = await harness({
        channelCount: 200,
        apiRateLimitPerSecond: 6,
        disabledActions: ['itv.get_all_channels'],
      });
      const start = Date.now();
      const channels = await collect(h.client.listChannels());
      const elapsed = Date.now() - start;
      expect(channels).toHaveLength(200);
      expect(h.runtime.http.requests.every((r) => r.status !== 429)).toBe(true);
      // 2 requêtes d'auth + 1 get_all_channels vide + 15 pages, à 200 ms d'intervalle.
      expect(elapsed).toBeGreaterThanOrEqual((h.runtime.http.requests.length - 1) * 200 - 50);
    });

    it('bannissement : erreur typée rate_limited, sans insister', async () => {
      h = await harness({ apiRateLimitPerSecond: 3 }, { tuning: { rateLimitPerSecond: 50 } });
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => h!.client.getGenres()));
      const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e instanceof StalkerError && e.kind === 'rate_limited')).toBe(true);
      // Insister prolongerait le bannissement : une requête 429 par appel, aucune relance.
      expect(h.runtime.http.requests.filter((r) => r.status === 429)).toHaveLength(errors.length);
    });
  });
});

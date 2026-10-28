import {
  ALL_PORTALS_ID,
  type EpisodeDto,
  type MovieDetailDto,
  type MovieListDto,
  type SeriesDetailDto,
  type SeriesListDto,
} from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiClient,
  type RunningPortal,
  type Stack,
  addPortal,
  startPortal,
  startStack,
  waitFor,
} from './helpers.js';

const MOVIES = 40;
const SERIES = 10;

/** Le tout premier chargement sert la liste au fil de sa lecture : on attend la copie complète. */
async function completeList<T extends MovieListDto | SeriesListDto>(
  client: ApiClient,
  path: string,
): Promise<T> {
  return waitFor(
    `catalogue complet ${path}`,
    async () => {
      const res = await client.get<T>(path);
      expect(res.status).toBe(200);
      return res.body.complete ? res.body : undefined;
    },
    60_000,
    200,
  );
}

describe('catalogue de films et de séries', () => {
  let stack: Stack;
  let base: string;
  beforeAll(async () => {
    stack = await startStack({ channelCount: 20, vodCount: MOVIES, seriesCount: SERIES });
    base = `/api/portals/${stack.portalDto.id}`;
  }, 120_000);
  afterAll(async () => stack.close());

  it('films : liste complète, catégories sans « tout », aucune commande ni adresse du portail', async () => {
    const list = await completeList<MovieListDto>(stack.srv.admin, `${base}/movies`);
    expect(list.items).toHaveLength(MOVIES);
    expect(new Set(list.items.map((m) => m.id)).size).toBe(MOVIES);
    expect(list.categories.length).toBeGreaterThan(0);
    expect(list.categories.some((c) => c.id === '*')).toBe(false);
    const res = await stack.srv.admin.get(`${base}/movies`);
    expect(res.text).not.toContain('/media/');
    expect(res.text).not.toContain(stack.portal.baseUrl);
    expect(list.items[0]?.poster).toMatch(new RegExp(`^${base}/movies/[^/]+/poster$`));
  });

  it('films : un catalogue inchangé ne coûte qu un 304', async () => {
    const first = await stack.srv.admin.get(`${base}/movies`);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const again = await stack.srv.admin.get(`${base}/movies`, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
  });

  it('fiche d un film : synopsis, réalisateur ; film inconnu : 404', async () => {
    const list = await completeList<MovieListDto>(stack.srv.admin, `${base}/movies`);
    const id = list.items[3]?.id ?? '';
    const res = await stack.srv.admin.get<MovieDetailDto>(`${base}/movies/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: list.items[3]?.name });
    expect(res.body.description.length).toBeGreaterThan(0);
    expect(res.text).not.toContain('/media/');
    expect((await stack.srv.admin.get(`${base}/movies/999999`)).status).toBe(404);
  });

  it('affiche relayée par Lumen', async () => {
    const list = await completeList<MovieListDto>(stack.srv.admin, `${base}/movies`);
    const res = await stack.srv.admin.get(list.items[0]?.poster ?? '');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('séries : liste, saisons dans l ordre, épisodes sans commande de lecture', async () => {
    const list = await completeList<SeriesListDto>(stack.srv.admin, `${base}/series`);
    expect(list.items).toHaveLength(SERIES);
    const series = list.items[0];
    const detail = await stack.srv.admin.get<SeriesDetailDto>(`${base}/series/${series?.id ?? ''}`);
    expect(detail.status).toBe(200);
    expect(detail.body.seasons.length).toBeGreaterThan(0);
    const numbers = detail.body.seasons.map((s) => s.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    const season = detail.body.seasons[0];
    const episodes = await stack.srv.admin.get<EpisodeDto[]>(
      `${base}/series/${series?.id ?? ''}/seasons/${season?.id ?? ''}`,
    );
    expect(episodes.status).toBe(200);
    expect(episodes.body).toHaveLength(season?.episodeCount ?? -1);
    expect(episodes.body.map((e) => e.number)).toEqual(episodes.body.map((_, i) => i + 1));
    expect(episodes.text).not.toContain('/media/');
    expect((await stack.srv.admin.get(`${base}/series/999999`)).status).toBe(404);
  });

  it('réservé aux comptes connectés', async () => {
    expect((await stack.srv.client().get(`${base}/movies`)).status).toBe(401);
    expect((await stack.srv.client().get(`${base}/series`)).status).toBe(401);
  });
});

describe('films et séries : copie locale et vue « Tous les portails »', () => {
  let stack: Stack;
  let second: RunningPortal;
  let secondId: string;
  beforeAll(async () => {
    stack = await startStack({ channelCount: 20, vodCount: MOVIES, seriesCount: SERIES });
    // Même graine : les mêmes titres, comme deux revendeurs d'un même bouquet.
    second = await startPortal({ channelCount: 20, vodCount: MOVIES, seriesCount: SERIES });
    secondId = (await addPortal(stack.srv.admin, second, { name: 'Second' })).id;
  }, 120_000);
  afterAll(async () => {
    await stack.close();
    await second.close().catch(() => undefined);
  });

  it('un film présent sur deux portails n apparaît qu une fois, avec ses deux sources', async () => {
    await completeList<MovieListDto>(stack.srv.admin, `/api/portals/${stack.portalDto.id}/movies`);
    await completeList<MovieListDto>(stack.srv.admin, `/api/portals/${secondId}/movies`);
    const all = await completeList<MovieListDto>(stack.srv.admin, `/api/portals/${ALL_PORTALS_ID}/movies`);
    expect(all.items).toHaveLength(MOVIES);
    for (const item of all.items) {
      expect(item.sources?.map((s) => s.portalId)).toEqual([stack.portalDto.id, secondId]);
    }
    // Catégories réunies par intitulé : pas de doublon.
    const titles = all.categories.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('portail en panne : la copie locale reste servie', async () => {
    const before = await completeList<SeriesListDto>(stack.srv.admin, `/api/portals/${secondId}/series`);
    await second.close();
    const after = await stack.srv.admin.get<SeriesListDto>(`/api/portals/${secondId}/series`);
    expect(after.status).toBe(200);
    expect(after.body.items).toHaveLength(before.items.length);
  });
});

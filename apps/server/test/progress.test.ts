import { PROGRESS_MAX, type ProgressDto, type ProgressUpdateRequest, isFinished } from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './helpers.js';

describe('reprise de lecture des films et épisodes', () => {
  let stack: Stack;
  const update = (patch: Partial<ProgressUpdateRequest>): ProgressUpdateRequest => ({
    kind: 'movie',
    portalId: stack.portalDto.id,
    itemId: '1',
    seriesId: null,
    seasonId: null,
    positionS: 600,
    durationS: 5400,
    label: null,
    ...patch,
  });

  beforeAll(async () => {
    stack = await startStack({ channelCount: 10, vodCount: 5, seriesCount: 2 });
  }, 120_000);
  afterAll(async () => stack.close());

  it('position enregistrée puis mise à jour ; le plus récent d abord', async () => {
    const admin = stack.srv.admin;
    expect(
      (await admin.request('PUT', '/api/progress', update({ itemId: '1', positionS: 100 }))).status,
    ).toBe(204);
    await admin.request(
      'PUT',
      '/api/progress',
      update({ kind: 'episode', itemId: '3:1:2', seriesId: '3', seasonId: '3:1', label: 'S1 · É2' }),
    );
    await admin.request('PUT', '/api/progress', update({ itemId: '1', positionS: 1200 }));
    const list = (await admin.get<ProgressDto[]>('/api/progress')).body;
    expect(list.map((p) => [p.kind, p.itemId, p.positionS])).toEqual([
      ['movie', '1', 1200],
      ['episode', '3:1:2', 600],
    ]);
    expect(list[1]).toMatchObject({ seriesId: '3', seasonId: '3:1', label: 'S1 · É2', finished: false });
  });

  it('presque fini : marqué vu (générique des titres longs, ou 95 %)', async () => {
    const admin = stack.srv.admin;
    await admin.request('PUT', '/api/progress', update({ itemId: '2', positionS: 5300, durationS: 5400 }));
    const list = (await admin.get<ProgressDto[]>('/api/progress')).body;
    expect(list.find((p) => p.itemId === '2')?.finished).toBe(true);
    // Un titre court n'est pas « vu » à trois minutes de la fin : ce serait presque tout le titre.
    expect(isFinished(10, 64)).toBe(false);
    expect(isFinished(62, 64)).toBe(true);
    expect(isFinished(40 * 60, 45 * 60)).toBe(false);
    expect(isFinished(42.5 * 60, 45 * 60)).toBe(true);
  });

  it('propre à chaque compte, et retirée sur demande', async () => {
    await stack.srv.admin.post('/api/users', { username: 'soeur', password: 'soeur-password' });
    const other = stack.srv.client();
    await other.login('soeur', 'soeur-password');
    expect((await other.get<ProgressDto[]>('/api/progress')).body).toEqual([]);
    expect((await stack.srv.admin.delete(`/api/progress/movie/${stack.portalDto.id}/1`)).status).toBe(204);
    const list = (await stack.srv.admin.get<ProgressDto[]>('/api/progress')).body;
    expect(list.some((p) => p.kind === 'movie' && p.itemId === '1')).toBe(false);
  });

  it('requête invalide ou portail inconnu refusés', async () => {
    const admin = stack.srv.admin;
    expect((await admin.request('PUT', '/api/progress', update({ positionS: -1 }))).status).toBe(400);
    expect((await admin.request('PUT', '/api/progress', update({ portalId: 'inconnu' }))).status).toBe(404);
    expect((await stack.srv.client().get('/api/progress')).status).toBe(401);
  });

  it(`au plus ${PROGRESS_MAX} titres : les plus anciens sont oubliés`, async () => {
    const admin = stack.srv.admin;
    for (let i = 0; i < PROGRESS_MAX + 5; i++) {
      await admin.request('PUT', '/api/progress', update({ itemId: `n${i}` }));
    }
    const list = (await admin.get<ProgressDto[]>('/api/progress')).body;
    expect(list).toHaveLength(PROGRESS_MAX);
    expect(list[0]?.itemId).toBe(`n${PROGRESS_MAX + 4}`);
    expect(list.some((p) => p.itemId === 'n0')).toBe(false);
  });
});

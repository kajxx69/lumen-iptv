import type { EpgBatchDto, FavoriteDto } from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './helpers.js';

describe('favoris et EPG groupé', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ channelCount: 50 });
  }, 120_000);
  afterAll(async () => stack.close());

  const fav = (channelId: string): string => `/api/favorites/${stack.portalDto.id}/${channelId}`;

  it('favoris : ajout idempotent, ordre d ajout, retrait', async () => {
    const admin = stack.srv.admin;
    expect((await admin.request('PUT', fav('3'))).status).toBe(204);
    expect((await admin.request('PUT', fav('1'))).status).toBe(204);
    expect((await admin.request('PUT', fav('3'))).status).toBe(204);
    let list = (await admin.get<FavoriteDto[]>('/api/favorites')).body;
    expect(list.map((f) => f.channelId)).toEqual(['3', '1']);
    expect(list[0]).toMatchObject({ portalId: stack.portalDto.id, addedAt: expect.any(Number) });
    expect((await admin.delete(fav('3'))).status).toBe(204);
    list = (await admin.get<FavoriteDto[]>('/api/favorites')).body;
    expect(list.map((f) => f.channelId)).toEqual(['1']);
  });

  it('favoris propres à chaque utilisateur', async () => {
    await stack.srv.admin.post('/api/users', { username: 'cousin', password: 'cousin-password' });
    const other = stack.srv.client();
    await other.login('cousin', 'cousin-password');
    expect((await other.get<FavoriteDto[]>('/api/favorites')).body).toEqual([]);
    await other.request('PUT', fav('7'));
    const mine = (await stack.srv.admin.get<FavoriteDto[]>('/api/favorites')).body;
    expect(mine.some((f) => f.channelId === '7')).toBe(false);
  });

  it('favori d une chaîne inconnue : 404', async () => {
    expect((await stack.srv.admin.request('PUT', fav('999999'))).status).toBe(404);
    const res = await stack.srv.admin.request('PUT', `/api/favorites/inexistant/1`);
    expect(res.status).toBe(404);
  });

  it('EPG groupé : plusieurs chaînes en une requête, fenêtre respectée', async () => {
    const now = Date.now();
    const from = now - 3_600_000;
    const to = now + 3 * 3_600_000;
    const res = await stack.srv.admin.get<EpgBatchDto>(
      `/api/portals/${stack.portalDto.id}/epg?channels=1,2,3&from=${from}&to=${to}`,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['1', '2', '3']);
    for (const entries of Object.values(res.body)) {
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.end).toBeGreaterThan(from);
        expect(e.start).toBeLessThan(to);
      }
    }
  });

  it('EPG groupé : trop de chaînes ou fenêtre invalide refusées', async () => {
    const ids = Array.from({ length: 41 }, (_, i) => String(i + 1)).join(',');
    const now = Date.now();
    const base = `/api/portals/${stack.portalDto.id}/epg`;
    expect((await stack.srv.admin.get(`${base}?channels=${ids}&from=${now}&to=${now + 1000}`)).status).toBe(
      400,
    );
    expect((await stack.srv.admin.get(`${base}?channels=1&from=${now}&to=${now - 1}`)).status).toBe(400);
  });

  it('EPG groupé : une chaîne en échec n empêche pas les autres de répondre', async () => {
    const now = Date.now();
    const res = await stack.srv.admin.get<EpgBatchDto>(
      `/api/portals/${stack.portalDto.id}/epg?channels=1,999999&from=${now}&to=${now + 3_600_000}`,
    );
    expect(res.status).toBe(200);
    expect(res.body['1']?.length).toBeGreaterThan(0);
    expect(res.body['999999']).toEqual([]);
  });
});

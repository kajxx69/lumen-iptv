import type { MeDto } from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, type TestServer, startServer } from './helpers.js';

/** PROJECT.md : « un relais ouvert devient un proxy exploité par des tiers en quelques jours ». */
describe('authentification', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer({ loginAttemptsPerWindow: 3, loginWindowMs: 60_000 });
  });
  afterAll(async () => srv.close());

  it('toute l API exige une session, flux compris', async () => {
    const anonymous = srv.client();
    for (const path of [
      '/api/auth/me',
      '/api/portals',
      '/api/portals/x/channels',
      '/api/portals/x/channels/1/logo',
      '/api/playback/x/stream',
    ]) {
      const res = await anonymous.get(path);
      expect(res.status, path).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'unauthorized' } });
    }
    expect((await anonymous.post('/api/playback', { portalId: 'x', channelId: '1' })).status).toBe(401);
  });

  it('le bilan de santé reste public', async () => {
    expect((await srv.client().get('/api/health')).status).toBe(200);
  });

  it('connexion : cookie de session HttpOnly, SameSite=Strict', async () => {
    const res = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lumen_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie.split(';')[0]!.length).toBeGreaterThan(40);
  });

  it('cookie Secure quand cookieSecure est actif (valeur par défaut)', async () => {
    const secure = await startServer({ cookieSecure: true });
    try {
      const res = await fetch(`${secure.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ADMIN),
      });
      expect(res.headers.getSetCookie().join(';')).toMatch(/Secure/);
    } finally {
      await secure.close();
    }
  });

  it('me renvoie l utilisateur connecté', async () => {
    const me = await srv.admin.get<MeDto>('/api/auth/me');
    expect(me.body).toEqual({ username: 'admin', role: 'admin' });
  });

  it('mauvais mot de passe ou utilisateur inconnu : même réponse 401', async () => {
    const a = await srv.client().login('admin', 'mauvais-mot-de-passe');
    const b = await srv.client().login('inconnu', 'mauvais-mot-de-passe');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('force brute : les tentatives sont plafonnées par fenêtre', async () => {
    const attacker = srv.client();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await attacker.login('cible', `essai-${i}`)).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('corps de requête invalide : 400', async () => {
    const res = await srv.client().post('/api/auth/login', { username: '' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('déconnexion : la session ne vaut plus rien', async () => {
    const c = srv.client();
    await c.login(ADMIN.username, ADMIN.password);
    const stolen = c.cookie;
    expect((await c.post('/api/auth/logout')).status).toBe(204);
    const replay = srv.client();
    replay.cookie = stolen;
    expect((await replay.get('/api/auth/me')).status).toBe(401);
  });

  describe('utilisateurs', () => {
    it('l admin crée un utilisateur, qui peut se connecter mais pas administrer', async () => {
      const created = await srv.admin.post('/api/users', {
        username: 'salon',
        password: 'tele-du-salon-1',
        role: 'user',
      });
      expect(created.status).toBe(201);
      const user = srv.client();
      expect((await user.login('salon', 'tele-du-salon-1')).status).toBe(204);
      expect((await user.get<MeDto>('/api/auth/me')).body).toEqual({ username: 'salon', role: 'user' });
      expect((await user.post('/api/users', { username: 'x', password: 'xxxxxxxxxxxx' })).status).toBe(403);
      expect((await user.post('/api/portals', {})).status).toBe(403);
    });

    it('mot de passe trop court ou nom déjà pris : refus', async () => {
      expect((await srv.admin.post('/api/users', { username: 'court', password: 'abc' })).status).toBe(400);
      expect(
        (await srv.admin.post('/api/users', { username: 'admin', password: 'un-mot-de-passe-long' })).status,
      ).toBe(409);
    });
  });

  describe('limitation par utilisateur', () => {
    it('au-delà du quota de requêtes : 429', async () => {
      const limited = await startServer({ apiRequestsPerMinute: 10 });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 14; i++) statuses.push((await limited.admin.get('/api/auth/me')).status);
        expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(10);
        expect(statuses.at(-1)).toBe(429);
      } finally {
        await limited.close();
      }
    });
  });
});

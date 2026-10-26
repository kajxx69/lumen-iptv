import { afterEach, describe, expect, it } from 'vitest';
import { StalkerClient, StalkerError } from '../../stalker/index.js';
import { type Harness, TEST_MAC, delay, harness, nodeRuntime, sendChaos, startPortal } from './helpers.js';

const rejection = async (p: Promise<unknown>): Promise<StalkerError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StalkerError);
    return err as StalkerError;
  }
  throw new Error('la promesse aurait dû échouer');
};

describe('client Stalker : découverte et authentification', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  describe('découverte du point d entrée', () => {
    it.each([
      [['/stalker_portal/server/load.php'], '/stalker_portal/c/'],
      [['/server/load.php'], '/c/'],
      [['/portal.php'], '/c/'],
      [['/c/portal.php'], '/c/'],
      [['/portal.php'], ''],
      [['/stalker_portal/server/load.php'], '/stalker_portal/c/index.html'],
    ])('portail servant %j, URL saisie « …%s »', async (entrypoints, path) => {
      const portal = await startPortal({ entrypoints });
      const runtime = nodeRuntime();
      const client = new StalkerClient({ portalUrl: `${portal.baseUrl}${path}`, mac: TEST_MAC }, runtime);
      try {
        const session = await client.authenticate();
        expect(session.endpoint).toBe(`${portal.baseUrl}${entrypoints[0]!}`);
      } finally {
        client.close();
        await portal.close();
      }
    });

    it('échoue proprement quand aucun point d entrée ne répond, en listant les essais', async () => {
      const portal = await startPortal({ entrypoints: ['/ailleurs/load.php'] });
      const client = new StalkerClient({ portalUrl: `${portal.baseUrl}/c/`, mac: TEST_MAC }, nodeRuntime());
      try {
        const err = await rejection(client.authenticate());
        expect(err.kind).toBe('endpoint_not_found');
        expect(err.details['tried']).toEqual(expect.arrayContaining([`${portal.baseUrl}/portal.php`]));
      } finally {
        await portal.close();
      }
    });

    it('utilise un point d entrée explicite sans sonder', async () => {
      h = await harness({ entrypoints: ['/portal.php'] });
      const client = new StalkerClient(
        { portalUrl: `${h.portal.baseUrl}/c/`, endpoint: `${h.portal.baseUrl}/portal.php`, mac: TEST_MAC },
        h.runtime,
      );
      await client.authenticate();
      client.close();
      expect(
        h.runtime.http.requests.filter((r) => !r.url.startsWith(`${h!.portal.baseUrl}/portal.php`)),
      ).toHaveLength(0);
    });
  });

  describe('séquence handshake → get_profile', () => {
    it('ouvre une session et lit le compte', async () => {
      h = await harness();
      const session = await h.client.authenticate();
      expect(session.status).toBe('active');
      expect(session.expiresAt).toBeGreaterThan(Date.now());
      expect(h.runtime.http.requests.map((r) => r.action)).toEqual(['handshake', 'get_profile']);
    });

    it('envoie les en-têtes MAG attendus par le portail', async () => {
      const seen: Record<string, string>[] = [];
      h = await harness();
      const runtime = nodeRuntime({
        request: (req) => {
          seen.push(req.headers);
          return h!.runtime.http.request(req);
        },
      });
      const client = new StalkerClient(
        { portalUrl: `${h.portal.baseUrl}/stalker_portal/c/`, mac: TEST_MAC },
        runtime,
      );
      await client.authenticate();
      client.close();
      const profileHeaders = seen.at(-1)!;
      expect(profileHeaders['Cookie']).toBe(
        'mac=00%3A1A%3A79%3A12%3A34%3A56; stb_lang=fr; timezone=Africa%2FAbidjan',
      );
      expect(profileHeaders['User-Agent']).toContain('MAG200 stbapp ver: 2 rev: 250');
      expect(profileHeaders['X-User-Agent']).toBe('Model: MAG250; Link: WiFi');
      expect(profileHeaders['Referer']).toBe(`${h.portal.baseUrl}/stalker_portal/c/`);
      expect(profileHeaders['Authorization']).toMatch(/^Bearer [0-9A-F]{32}$/);
    });

    it.each(['MAG254', 'MAG322'] as const)('profil d appareil %s accepté', async (device) => {
      h = await harness({}, { device });
      await expect(h.client.authenticate()).resolves.toMatchObject({ status: 'active' });
    });

    it('appareil refusé : erreur typée immédiate, sans boucle de renouvellement', async () => {
      h = await harness({ allowedModels: ['MAG250'] }, { device: 'MAG322' });
      const err = await rejection(h.client.authenticate());
      expect(err.kind).toBe('device_rejected');
      // Un portail qui refuse l'appareil ne doit pas être martelé (risque de bannissement).
      expect(h.runtime.http.requests.length).toBeLessThanOrEqual(8);
    });
  });

  describe('do_auth', () => {
    it('n est appelé que si le profil l exige', async () => {
      h = await harness({}, { credentials: { login: 'demo', password: 'demo' } });
      await h.client.authenticate();
      expect(h.runtime.http.count('do_auth')).toBe(0);
    });

    it('débloque un compte qui l exige', async () => {
      h = await harness({ requireDoAuth: true }, { credentials: { login: 'demo', password: 'demo' } });
      const session = await h.client.authenticate();
      expect(session.status).toBe('active');
      expect(h.runtime.http.requests.map((r) => r.action)).toEqual([
        'handshake',
        'get_profile',
        'do_auth',
        'get_profile',
      ]);
      expect((await h.client.getGenres()).length).toBeGreaterThan(1);
    });

    it('signale des identifiants manquants ou faux par des erreurs distinctes', async () => {
      h = await harness({ requireDoAuth: true });
      expect((await rejection(h.client.authenticate())).kind).toBe('auth_required');
      const wrong = new StalkerClient(
        {
          portalUrl: `${h.portal.baseUrl}/stalker_portal/c/`,
          mac: TEST_MAC,
          credentials: { login: 'demo', password: 'non' },
        },
        nodeRuntime(),
      );
      expect((await rejection(wrong.authenticate())).kind).toBe('auth_failed');
      wrong.close();
    });
  });

  describe('maintien de session', () => {
    it('renouvelle le token de façon transparente après expiration (401)', async () => {
      h = await harness();
      await h.client.authenticate();
      const firstToken = h.client.session?.token;
      await sendChaos(h.portal.baseUrl, 'expire-token');
      const genres = await h.client.getGenres();
      expect(genres.length).toBeGreaterThan(1);
      expect(h.client.session?.token).not.toBe(firstToken);
    });

    it('un seul renouvellement pour des appels simultanés', async () => {
      h = await harness({}, { tuning: { rateLimitPerSecond: 50 } });
      await h.client.authenticate();
      await sendChaos(h.portal.baseUrl, 'expire-token');
      h.runtime.http.reset();
      await Promise.all([
        h.client.getGenres(),
        h.client.getVodCategories(),
        h.client.getMainInfo(),
        h.client.getGenres(),
      ]);
      expect(h.runtime.http.count('handshake')).toBe(1);
    });

    it('authentifie à la demande si aucune session n existe encore', async () => {
      h = await harness();
      expect((await h.client.getGenres()).length).toBeGreaterThan(1);
      expect(h.runtime.http.count('handshake')).toBe(1);
    });

    it('get_profile périodique : la session survit au délai d inactivité du portail', async () => {
      const IDLE_TTL_MS = 1500;
      h = await harness({ sessionTokenTtlMs: IDLE_TTL_MS }, { tuning: { keepAliveIntervalMs: 500 } });
      await h.client.authenticate();
      const token = h.client.session?.token;
      await delay(IDLE_TTL_MS * 2.5);
      expect(h.runtime.http.count('get_profile')).toBeGreaterThanOrEqual(5);
      await h.client.getGenres();
      // Aucun renouvellement n'a été nécessaire : le maintien a fonctionné.
      expect(h.client.session?.token).toBe(token);
      expect(h.runtime.http.count('handshake')).toBe(1);
    });

    it('close() arrête le maintien de session', async () => {
      h = await harness({}, { tuning: { keepAliveIntervalMs: 200 } });
      await h.client.authenticate();
      h.client.close();
      const count = h.runtime.http.requests.length;
      await delay(700);
      expect(h.runtime.http.requests.length).toBe(count);
    });
  });

  describe('sécurité des journaux', () => {
    it('ne journalise jamais la MAC, le token ni les identifiants', async () => {
      h = await harness(
        { requireDoAuth: true, login: 'demo-login', password: 's3cret-pass' },
        { credentials: { login: 'demo-login', password: 's3cret-pass' } },
      );
      await h.client.authenticate();
      await h.client.createLink('ffmpeg http://localhost/ch/1_');
      await sendChaos(h.portal.baseUrl, 'expire-token');
      await h.client.getGenres();
      const logs = h.runtime.logger.text();
      expect(h.runtime.logger.entries.length).toBeGreaterThan(0);
      for (const secret of [
        TEST_MAC,
        encodeURIComponent(TEST_MAC),
        h.client.session!.token,
        's3cret-pass',
        'demo-login',
        'play_token',
      ]) {
        expect(logs).not.toContain(secret);
      }
    });
  });
});

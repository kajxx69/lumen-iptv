import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortalDto } from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PORTAL_MAC,
  type RunningPortal,
  type TestServer,
  addPortal,
  startPortal,
  startServer,
} from './helpers.js';

describe('portails', () => {
  let portal: RunningPortal;
  let srv: TestServer;
  beforeAll(async () => {
    portal = await startPortal({
      requireDoAuth: true,
      login: 'login-abonne-42',
      password: 'abonnement-secret',
    });
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
    await portal.close();
  });

  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Mon abonnement',
    url: `${portal.baseUrl}/stalker_portal/c/`,
    mac: PORTAL_MAC,
    login: 'login-abonne-42',
    password: 'abonnement-secret',
    ...extra,
  });

  it('ajout : le portail est vérifié, la réponse ne contient aucun secret', async () => {
    const res = await srv.admin.post<PortalDto>('/api/portals', body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Mon abonnement',
      host: new URL(portal.baseUrl).host,
      macMasked: '**:**:**:**:CD:EF',
      device: 'MAG250',
    });
    for (const secret of [PORTAL_MAC, 'abonnement-secret', 'login-abonne-42', '/stalker_portal']) {
      expect(res.text).not.toContain(secret);
    }
  });

  it('liste : visible par tout utilisateur connecté, toujours masquée', async () => {
    await srv.admin.post('/api/users', { username: 'lecteur', password: 'lecteur-password' });
    const user = srv.client();
    await user.login('lecteur', 'lecteur-password');
    const list = await user.get<PortalDto[]>('/api/portals');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.text).not.toContain(PORTAL_MAC);
  });

  it('identifiants faux : refus explicite, rien n est enregistré', async () => {
    const before = (await srv.admin.get<PortalDto[]>('/api/portals')).body.length;
    const res = await srv.admin.post('/api/portals', body({ password: 'faux' }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'portal_auth_failed' } });
    expect(res.text).not.toContain('faux');
    expect((await srv.admin.get<PortalDto[]>('/api/portals')).body.length).toBe(before);
  });

  it('portail injoignable ou URL sans Stalker : refus explicite', async () => {
    const dead = await srv.admin.post('/api/portals', body({ url: 'http://127.0.0.1:1/c/' }));
    expect(dead.status).toBe(422);
    expect(dead.body).toMatchObject({ error: { code: 'portal_unreachable' } });
  });

  it('appareil refusé par le portail : code dédié', async () => {
    const strict = await startPortal({ allowedModels: ['MAG250'] });
    try {
      const res = await srv.admin.post('/api/portals', {
        name: 'Strict',
        url: `${strict.baseUrl}/c/`,
        mac: PORTAL_MAC,
        device: 'MAG322',
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: { code: 'portal_device_rejected' } });
    } finally {
      await strict.close();
    }
  });

  it('validation : URL, MAC et modèle', async () => {
    expect((await srv.admin.post('/api/portals', body({ url: 'ftp://x/c/' }))).status).toBe(400);
    expect((await srv.admin.post('/api/portals', body({ mac: 'pas-une-mac' }))).status).toBe(400);
    expect((await srv.admin.post('/api/portals', body({ device: 'MAG999' }))).status).toBe(400);
  });

  it('suppression réservée à l admin', async () => {
    const created = await srv.admin.post<PortalDto>('/api/portals', body({ name: 'À supprimer' }));
    const user = srv.client();
    await user.login('lecteur', 'lecteur-password');
    expect((await user.delete(`/api/portals/${created.body.id}`)).status).toBe(403);
    expect((await srv.admin.delete(`/api/portals/${created.body.id}`)).status).toBe(204);
    expect((await srv.admin.get(`/api/portals/${created.body.id}/channels`)).status).toBe(404);
  });

  it('au repos : ni URL, ni MAC, ni identifiants en clair dans la base SQLite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumen-db-'));
    const databasePath = join(dir, 'lumen.db');
    const masterKey = randomBytes(32).toString('base64');
    const onDisk = await startServer({ databasePath, masterKey });
    try {
      await addPortal(onDisk.admin, portal, { login: 'login-abonne-42', password: 'abonnement-secret' });
    } finally {
      await onDisk.close();
    }
    // Base + éventuels fichiers WAL : tout ce qui touche le disque.
    for (const file of await readdir(dir)) {
      const raw = (await readFile(join(dir, file))).toString('latin1');
      for (const secret of [
        PORTAL_MAC,
        'abonnement-secret',
        new URL(portal.baseUrl).host,
        'stalker_portal',
      ]) {
        expect(raw, `${file} contient « ${secret} »`).not.toContain(secret);
      }
    }
    // La même clé relit la configuration après redémarrage.
    const restarted = await startServer({ databasePath, masterKey });
    try {
      const list = await restarted.admin.get<PortalDto[]>('/api/portals');
      expect(list.body[0]?.macMasked).toBe('**:**:**:**:CD:EF');
      expect((await restarted.admin.get(`/api/portals/${list.body[0]!.id}/genres`)).status).toBe(200);
    } finally {
      await restarted.close();
    }
  });
});

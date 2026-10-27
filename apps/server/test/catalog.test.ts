import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ChannelListDto, EpgEntryDto, GenreDto, PortalHealthDto, VodPageDto } from '@lumen/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  ApiClient,
  PORTAL_MAC,
  type Stack,
  addPortal,
  delay,
  sendChaos,
  startPortal,
  startServer,
  startStack,
} from './helpers.js';

const HOUR = 3_600_000;

describe('catalogue à travers le backend', () => {
  let stack: Stack;
  let base: string;
  beforeAll(async () => {
    stack = await startStack();
    base = `/api/portals/${stack.portalDto.id}`;
  });
  afterAll(async () => stack.close());

  it('liste les 5 000 chaînes, normalisées, sans référence amont', async () => {
    const res = await stack.srv.admin.get<ChannelListDto>(`${base}/channels`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(5000);
    expect(res.body.channels[0]).toMatchObject({ id: '1', number: 1, censored: false });
    expect(res.body.version).toMatch(/^[0-9a-f]{16,}$/);
    // Ni l'hôte du portail ni les commandes de lecture ne sortent du serveur.
    expect(res.text).not.toContain(new URL(stack.portal.baseUrl).host);
    expect(res.text).not.toContain('ffmpeg');
    expect(res.text).not.toContain('localhost/ch');
    const withLogo = res.body.channels.find((c) => c.logo !== null)!;
    expect(withLogo.logo).toBe(`${base}/channels/${withLogo.id}/logo`);
  });

  it('ETag : une liste inchangée coûte une réponse vide (304)', async () => {
    const first = await stack.srv.admin.get<ChannelListDto>(`${base}/channels`);
    const etag = first.headers.get('etag')!;
    expect(etag).toBe(`"${first.body.version}"`);
    const again = await stack.srv.admin.get(`${base}/channels`, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
  });

  it('compression gzip : la liste complète pèse quelques centaines de Ko', async () => {
    const res = await fetch(`${stack.srv.baseUrl}${base}/channels`, {
      headers: { Cookie: stack.srv.admin.cookie!, 'Accept-Encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toMatch(/Accept-Encoding/i);
    // fetch décompresse ; on mesure la taille réelle transférée via un second appel brut.
    const raw = await new Promise<Buffer>((resolve, reject) => {
      import('node:http')
        .then(({ get }) =>
          get(
            `${stack.srv.baseUrl}${base}/channels`,
            { headers: { Cookie: stack.srv.admin.cookie!, 'Accept-Encoding': 'gzip' } },
            (r) => {
              const parts: Buffer[] = [];
              r.on('data', (c: Buffer) => parts.push(c));
              r.on('end', () => resolve(Buffer.concat(parts)));
            },
          ).on('error', reject),
        )
        .catch(reject);
    });
    const plain = gunzipSync(raw);
    expect(raw.length).toBeLessThan(plain.length / 4);
    expect((JSON.parse(plain.toString()) as ChannelListDto).channels).toHaveLength(5000);
  });

  it('genres', async () => {
    const res = await stack.srv.admin.get<GenreDto[]>(`${base}/genres`);
    expect(res.body[0]).toEqual({ id: '*', title: 'Tout', censored: false });
    expect(res.body.some((g) => g.censored)).toBe(true);
  });

  it('logos servis par le backend (pas de contenu mixte), absents → 404', async () => {
    const { channels } = (await stack.srv.admin.get<ChannelListDto>(`${base}/channels`)).body;
    const withLogo = channels.find((c) => c.logo !== null)!;
    const logo = await fetch(`${stack.srv.baseUrl}${withLogo.logo!}`, {
      headers: { Cookie: stack.srv.admin.cookie! },
    });
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('cache-control')).toMatch(/max-age=\d+/);
    const without = channels.find((c) => c.logo === null)!;
    expect((await stack.srv.admin.get(`${base}/channels/${without.id}/logo`)).status).toBe(404);
  });

  it('EPG d une chaîne sur une fenêtre', async () => {
    const now = Date.now();
    const res = await stack.srv.admin.get<EpgEntryDto[]>(
      `${base}/channels/7/epg?from=${now}&to=${now + 4 * HOUR}`,
    );
    expect(res.status).toBe(200);
    expect(res.body[0]!.start).toBeLessThanOrEqual(now);
    expect(res.body.at(-1)!.end).toBeGreaterThanOrEqual(now + 4 * HOUR);
    expect(res.text).not.toContain('/media/');
  });

  it('EPG : fenêtre invalide ou trop large refusée', async () => {
    const now = Date.now();
    expect((await stack.srv.admin.get(`${base}/channels/7/epg?from=${now}&to=${now - 1}`)).status).toBe(400);
    expect(
      (await stack.srv.admin.get(`${base}/channels/7/epg?from=${now}&to=${now + 30 * 24 * HOUR}`)).status,
    ).toBe(400);
  });

  it('VOD : page avec recherche', async () => {
    const res = await stack.srv.admin.get<VodPageDto>(`${base}/vod?page=1`);
    expect(res.body).toMatchObject({ page: 1, pageSize: 14, totalItems: 1500 });
    expect(res.body.items).toHaveLength(14);
    expect(res.text).not.toContain('/media/');
  });

  it('portail inconnu : 404', async () => {
    expect((await stack.srv.admin.get('/api/portals/inconnu/channels')).status).toBe(404);
  });
});

describe('cache du catalogue', () => {
  let stack: Stack | undefined;
  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  });

  it('servi depuis le cache quand le portail tombe', async () => {
    stack = await startStack({ channelCount: 100 });
    const path = `/api/portals/${stack.portalDto.id}/channels`;
    expect((await stack.srv.admin.get<ChannelListDto>(path)).body.channels).toHaveLength(100);
    await stack.portal.close();
    const cached = await stack.srv.admin.get<ChannelListDto>(path);
    expect(cached.status).toBe(200);
    expect(cached.body.channels).toHaveLength(100);
  });

  it('rafraîchi en arrière-plan quand il vieillit, sans faire attendre', async () => {
    stack = await startStack({ channelCount: 100 }, { catalogTtlMs: 300 });
    const path = `/api/portals/${stack.portalDto.id}/channels`;
    const first = await stack.srv.admin.get<ChannelListDto>(path);
    await delay(400);
    const stale = await stack.srv.admin.get<ChannelListDto>(path);
    // Réponse immédiate avec l'ancienne version, rafraîchissement lancé derrière.
    expect(stale.body.syncedAt).toBe(first.body.syncedAt);
    await delay(1500);
    const fresh = await stack.srv.admin.get<ChannelListDto>(path);
    expect(fresh.body.syncedAt).toBeGreaterThan(first.body.syncedAt);
  });

  it('portail tombé juste après une vérification réussie : la panne se voit aussitôt', async () => {
    const s = await startStack({ channelCount: 50 });
    stack = s;
    const health = async (): Promise<boolean> =>
      (await s.srv.admin.get<PortalHealthDto>(`/api/portals/${s.portalDto.id}/health`)).body.reachable;
    expect(await health()).toBe(true);
    await sendChaos(s.portal.baseUrl, 'http-error', { code: 503, probability: 1, scope: 'all' });
    expect(await health()).toBe(false);
    await sendChaos(s.portal.baseUrl, 'reset');
    expect(await health()).toBe(true);
  });

  it('synchronisation forcée par l admin', async () => {
    stack = await startStack({ channelCount: 50 });
    const res = await stack.srv.admin.post(`/api/portals/${stack.portalDto.id}/sync`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ channels: 50 });
  });

  it('portail sans get_all_channels : le backend pagine', async () => {
    stack = await startStack({ channelCount: 120, disabledActions: ['itv.get_all_channels'] });
    const res = await stack.srv.admin.get<ChannelListDto>(`/api/portals/${stack.portalDto.id}/channels`);
    expect(res.body.channels.map((c) => c.id)).toEqual(Array.from({ length: 120 }, (_, i) => String(i + 1)));
  });

  it('survit au redémarrage, sans secret en clair sur le disque', async () => {
    const portal = await startPortal({ channelCount: 80 });
    const dir = await mkdtemp(join(tmpdir(), 'lumen-cat-'));
    const databasePath = join(dir, 'lumen.db');
    const masterKey = randomBytes(32).toString('base64');
    const first = await startServer({ databasePath, masterKey });
    const dto = await addPortal(first.admin, portal);
    expect(
      (await first.admin.get<ChannelListDto>(`/api/portals/${dto.id}/channels`)).body.channels,
    ).toHaveLength(80);
    await first.close();
    await portal.close();

    for (const file of await readdir(dir)) {
      const raw = (await readFile(join(dir, file))).toString('latin1');
      for (const secret of [PORTAL_MAC, new URL(portal.baseUrl).host])
        expect(raw, file).not.toContain(secret);
    }

    // Redémarrage, portail toujours hors service : l'ouverture reste instantanée.
    const second = await startServer({ databasePath, masterKey });
    try {
      const client = new ApiClient(second.baseUrl);
      await client.login(ADMIN.username, ADMIN.password);
      const start = Date.now();
      const res = await client.get<ChannelListDto>(`/api/portals/${dto.id}/channels`);
      expect(res.body.channels).toHaveLength(80);
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      await second.close();
    }
  });
});

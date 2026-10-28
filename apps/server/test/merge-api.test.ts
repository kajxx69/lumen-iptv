import type {
  ChannelHealthDto,
  ChannelListDto,
  EpgBatchDto,
  FavoriteDto,
  GenreDto,
  MergeSettingsDto,
  PortalDto,
} from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningPortal, type TestServer, addPortal, startPortal, startServer } from './helpers.js';

const HOUR = 3_600_000;
const CHANNELS_A = 200;
const CHANNELS_B = 100;

/**
 * Deux portails qui nomment la même chaîne autrement (« FR | NOVA TV FHD » et « Nova TV
 * France 1080 ») ; une chaîne sur sept environ n'a pas d'identifiant EPG.
 */
describe('vue « Tous les portails » à travers le backend', () => {
  let a: RunningPortal;
  let b: RunningPortal;
  let srv: TestServer;
  let dtoA: PortalDto;
  let dtoB: PortalDto;
  const list = async (): Promise<ChannelListDto> =>
    (await srv.admin.get<ChannelListDto>('/api/portals/all/channels')).body;
  const putOverride = (body: unknown) =>
    srv.admin.request<MergeSettingsDto>('PUT', '/api/catalog/merge/overrides', body);

  beforeAll(async () => {
    a = await startPortal({ channelCount: CHANNELS_A, namingStyle: 'pipe' });
    b = await startPortal({ channelCount: CHANNELS_B, namingStyle: 'plain', seed: 2, portalName: 'B' });
    srv = await startServer();
    dtoA = await addPortal(srv.admin, a, { name: 'A' });
    dtoB = await addPortal(srv.admin, b, { name: 'B', mac: '00:1A:79:AB:CD:EE' });
  });
  afterAll(async () => {
    await srv.close();
    await a.close();
    await b.close();
  });

  it('une entrée par chaîne : les chaînes communes aux deux portails portent deux sources', async () => {
    const res = await srv.admin.get<ChannelListDto>('/api/portals/all/channels');
    expect(res.status).toBe(200);
    expect(res.body.portalId).toBe('all');
    expect(res.body.channels).toHaveLength(CHANNELS_A);
    const shared = res.body.channels.filter((c) => c.sources?.length === 2);
    expect(shared).toHaveLength(CHANNELS_B);
    for (const c of shared) {
      expect(new Set(c.sources?.map((s) => s.portalId))).toEqual(new Set([dtoA.id, dtoB.id]));
    }
    // Rien de l'amont ne sort : ni commande de lecture, ni adresse de portail.
    expect(res.text).not.toMatch(/ffmpeg|127\.0\.0\.1|cmd/);
    // Revalidation : un catalogue fusionné inchangé ne coûte qu'un 304.
    const etag = res.headers.get('etag') ?? '';
    expect((await srv.admin.get('/api/portals/all/channels', { 'If-None-Match': etag })).status).toBe(304);
  });

  it('genres de même intitulé réunis', async () => {
    const all = (await srv.admin.get<GenreDto[]>('/api/portals/all/genres')).body;
    const ofA = (await srv.admin.get<GenreDto[]>(`/api/portals/${dtoA.id}/genres`)).body;
    expect(all.map((g) => g.title).sort()).toEqual(ofA.map((g) => g.title).sort());
  });

  it('programme d une chaîne fusionnée servi depuis la source qui porte l EPG', async () => {
    const withEpg = (await list()).channels.find((c) => c.epgId !== null && c.sources?.length === 2);
    expect(withEpg).toBeDefined();
    const id = withEpg?.id ?? '';
    const now = Date.now();
    const res = await srv.admin.get<EpgBatchDto>(
      `/api/portals/all/epg?channels=${encodeURIComponent(id)}&from=${now}&to=${now + 2 * HOUR}`,
    );
    expect(res.status).toBe(200);
    expect(res.body[id]?.length ?? 0).toBeGreaterThan(0);
  });

  it('corrections manuelles : séparer puis annuler, réservé à l administrateur', async () => {
    const shared = (await list()).channels.find((c) => c.sources?.length === 2);
    const fromB = shared?.sources?.find((s) => s.portalId === dtoB.id);
    expect(fromB).toBeDefined();
    const ref = { portalId: fromB?.portalId, channelId: fromB?.channelId };

    const anonymous = srv.client();
    const denied = await anonymous.request('PUT', '/api/catalog/merge/overrides', { ...ref, target: 'solo' });
    expect(denied.status).toBe(401);

    const split = await putOverride({ ...ref, target: 'solo' });
    expect(split.status).toBe(200);
    expect(split.body.overrides).toEqual([{ ...ref, target: 'solo' }]);
    expect((await list()).channels).toHaveLength(CHANNELS_A + 1);

    await putOverride({ ...ref, target: null });
    expect((await list()).channels).toHaveLength(CHANNELS_A);
    // Portail inconnu : refusé.
    expect((await putOverride({ portalId: 'inconnu', channelId: '1', target: 'solo' })).status).toBe(404);
  });

  it('favori d une chaîne fusionnée : rangé sur sa première source, retiré de toutes', async () => {
    const shared = (await list()).channels.find((c) => c.sources?.length === 2);
    const id = encodeURIComponent(shared?.id ?? '');
    expect((await srv.admin.request('PUT', `/api/favorites/all/${id}`)).status).toBe(204);
    const favorites = (await srv.admin.get<FavoriteDto[]>('/api/favorites')).body;
    expect(favorites.map((f) => ({ portalId: f.portalId, channelId: f.channelId }))).toEqual([
      { portalId: shared?.sources?.[0]?.portalId, channelId: shared?.sources?.[0]?.channelId },
    ]);
    expect((await srv.admin.delete(`/api/favorites/all/${id}`)).status).toBe(204);
    expect((await srv.admin.get<FavoriteDto[]>('/api/favorites')).body).toEqual([]);
    expect((await srv.admin.request('PUT', '/api/favorites/all/inconnue')).status).toBe(404);
  });

  it('fusion désactivable par l administrateur', async () => {
    expect((await srv.admin.get<MergeSettingsDto>('/api/catalog/merge')).body.enabled).toBe(true);
    const off = await srv.admin.request<MergeSettingsDto>('PUT', '/api/catalog/merge', { enabled: false });
    expect(off.body.enabled).toBe(false);
    await srv.admin.request('PUT', '/api/catalog/merge', { enabled: true });
  });
});

describe('ordre des sources : alterner les serveurs', () => {
  it('deux abonnements chez le même fournisseur ne se suivent pas dans l ordre de bascule', async () => {
    const a = await startPortal({ channelCount: 20 });
    const b = await startPortal({ channelCount: 20, seed: 2, portalName: 'B' });
    const srv = await startServer();
    try {
      const dtoA = await addPortal(srv.admin, a, { name: 'A' });
      const twin = await addPortal(srv.admin, a, { name: 'A bis', mac: '00:1A:79:AB:CD:01' });
      const dtoB = await addPortal(srv.admin, b, { name: 'B', mac: '00:1A:79:AB:CD:EE' });
      const shared = (await srv.admin.get<ChannelListDto>('/api/portals/all/channels')).body.channels.find(
        (c) => c.sources?.length === 3,
      );
      expect(shared).toBeDefined();
      const onA = shared?.sources?.find((s) => s.portalId === dtoA.id)?.channelId ?? '';
      const health = await srv.admin.get<ChannelHealthDto>(`/api/portals/${dtoA.id}/channels/${onA}/health`);
      // Scores égaux (rien n'est encore connu) : A demandée, puis B, puis le jumeau de A.
      expect(health.body.sources.map((s) => s.portalId)).toEqual([dtoA.id, dtoB.id, twin.id]);
    } finally {
      await srv.close();
      await a.close();
      await b.close();
    }
  });
});

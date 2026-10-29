import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, delay, sendChaos, startPlayback, startStack } from './helpers.js';

/** Portail lent à répondre (réseau mobile, serveur chargé) : chaque appel d'API coûte 800 ms. */
const API_LATENCY_MS = 800;

describe('zapping instantané : liens des chaînes voisines demandés à l avance', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ channelCount: 20 });
    // Session ouverte avant la latence : seul create_link la subit ensuite.
    await stack.srv.admin.get(`/api/portals/${stack.portalDto.id}/channels`);
    await sendChaos(stack.portal.baseUrl, 'latency', { ms: API_LATENCY_MS, scope: 'api' });
  }, 120_000);
  afterAll(async () => {
    await sendChaos(stack.portal.baseUrl, 'reset').catch(() => undefined);
    await stack.close();
  });

  const timedStart = async (channelId: string): Promise<number> => {
    const started = Date.now();
    const pb = await startPlayback(stack.srv.admin, { portalId: stack.portalDto.id, channelId });
    const ms = Date.now() - started;
    await stack.srv.admin.delete(`/api/playback/${pb.sessionId}`);
    return ms;
  };

  it('une chaîne préparée démarre sans attendre le portail', async () => {
    const cold = await timedStart('3');
    const res = await stack.srv.admin.post('/api/playback/prefetch', {
      channels: [{ portalId: stack.portalDto.id, channelId: '5' }],
    });
    expect(res.status).toBe(202);
    // Le lien arrive après la latence du portail.
    await delay(API_LATENCY_MS * 2);
    const prepared = await timedStart('5');
    console.log(`démarrage : ${cold} ms sans préparation, ${prepared} ms avec`);
    expect(cold - prepared).toBeGreaterThan(API_LATENCY_MS * 0.6);
  }, 60_000);

  it('seules les chaînes préparées en profitent : les autres interrogent le portail', async () => {
    await stack.srv.admin.post('/api/playback/prefetch', {
      channels: [{ portalId: stack.portalDto.id, channelId: '7' }],
    });
    await delay(API_LATENCY_MS * 2);
    const first = await timedStart('7');
    // Une chaîne non préparée paie l'aller-retour au portail.
    await delay(500);
    const second = await timedStart('9');
    expect(second - first).toBeGreaterThan(API_LATENCY_MS * 0.6);
  }, 60_000);

  it('au plus quatre chaînes par demande ; réservé aux comptes connectés', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      portalId: stack.portalDto.id,
      channelId: String(i + 1),
    }));
    expect((await stack.srv.admin.post('/api/playback/prefetch', { channels: many })).status).toBe(400);
    expect((await stack.srv.client().post('/api/playback/prefetch', { channels: [] })).status).toBe(401);
  });
});

import type { PlaybackDto } from '@lumen/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type Stack, delay, readPlaylist, sendChaos, startStack } from './helpers.js';

describe('sessions de lecture', () => {
  let stack: Stack | undefined;
  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  });

  const start = async (s: Stack, channelId = '1', client = s.srv.admin): Promise<PlaybackDto> => {
    const res = await client.post<PlaybackDto>('/api/playback', { portalId: s.portalDto.id, channelId });
    if (res.status !== 201) throw new Error(`lecture refusée : ${res.status} ${res.text}`);
    return res.body;
  };

  it('token expiré côté portail avant le démarrage : renouvelé de façon transparente', async () => {
    stack = await startStack({ channelCount: 50 });
    await stack.srv.admin.get(`/api/portals/${stack.portalDto.id}/channels`);
    await sendChaos(stack.portal.baseUrl, 'expire-token');
    const playback = await start(stack, '3');
    expect(
      (await readPlaylist(stack.srv.admin, playback.streamUrl)).playlist.segments.length,
    ).toBeGreaterThan(0);
  });

  it('chaîne inconnue : erreur claire', async () => {
    stack = await startStack({ channelCount: 50 });
    const res = await stack.srv.admin.post('/api/playback', {
      portalId: stack.portalDto.id,
      channelId: '999999',
    });
    expect(res.status).toBe(404);
  });

  it('source de secours inconnue : refusée avant toute connexion amont', async () => {
    stack = await startStack({ channelCount: 50 });
    const res = await stack.srv.admin.post('/api/playback', {
      portalId: stack.portalDto.id,
      channelId: '1',
      fallbacks: [{ portalId: 'inexistant', channelId: '1' }],
    });
    expect(res.status).toBe(404);
  });

  it('trop de sources de secours : requête invalide', async () => {
    stack = await startStack({ channelCount: 50 });
    const fallbacks = Array.from({ length: 5 }, (_, i) => ({
      portalId: stack!.portalDto.id,
      channelId: String(i + 2),
    }));
    const res = await stack.srv.admin.post('/api/playback', {
      portalId: stack.portalDto.id,
      channelId: '1',
      fallbacks,
    });
    expect(res.status).toBe(400);
  });

  it('plafond de flux simultanés par utilisateur', async () => {
    stack = await startStack({ channelCount: 50 }, { maxStreamsPerUser: 2 });
    await start(stack, '1');
    await start(stack, '2');
    const third = await stack.srv.admin.post('/api/playback', {
      portalId: stack.portalDto.id,
      channelId: '3',
    });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: { code: 'too_many_streams' } });
  });

  it('arrêter une lecture libère sa place', async () => {
    stack = await startStack({ channelCount: 50 }, { maxStreamsPerUser: 1 });
    const first = await start(stack, '1');
    expect((await stack.srv.admin.delete(`/api/playback/${first.sessionId}`)).status).toBe(204);
    await start(stack, '2');
  });

  it('une lecture abandonnée expire et libère sa place', async () => {
    stack = await startStack({ channelCount: 50 }, { maxStreamsPerUser: 1, playbackIdleTtlMs: 300 });
    await start(stack, '1');
    await delay(1200);
    await start(stack, '2');
  });

  it('une session de lecture n est accessible qu à son propriétaire', async () => {
    stack = await startStack({ channelCount: 50 });
    const playback = await start(stack);
    const { playlist } = await readPlaylist(stack.srv.admin, playback.streamUrl);
    await stack.srv.admin.post('/api/users', { username: 'voisin', password: 'voisin-password' });
    const other = stack.srv.client();
    await other.login('voisin', 'voisin-password');
    expect((await other.get(playback.streamUrl)).status).toBe(404);
    const segmentPath = new URL(playlist.segments[0]!.uri).pathname;
    expect((await other.get(segmentPath)).status).toBe(404);
    expect((await other.delete(`/api/playback/${playback.sessionId}`)).status).toBe(404);
  });

  it('segment hors fenêtre et hors cache : 404 propre', async () => {
    stack = await startStack({ channelCount: 50 });
    const playback = await start(stack);
    const base = playback.streamUrl.replace(/index\.m3u8$/, '');
    expect((await stack.srv.admin.get(`${base}seg/999999.ts`)).status).toBe(404);
    expect((await stack.srv.admin.get(`${base}seg/abc.ts`)).status).toBe(400);
  });
});

import type { PlaybackDto } from '@lumen/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type Stack, delay, firstBytes, sendChaos, startStack } from './helpers.js';

describe('lecture à travers le backend', () => {
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

  it('flux TS : servi par le backend, sans exposer l URL amont', async () => {
    stack = await startStack({ channelCount: 50 });
    const playback = await start(stack);
    expect(playback.format).toBe('ts');
    expect(playback.streamUrl).toBe(`/api/playback/${playback.sessionId}/stream`);
    expect(JSON.stringify(playback)).not.toMatch(/play_token|live\.php|127\.0\.0\.1/);
    const { status, contentType, bytes } = await firstBytes(`${stack.srv.baseUrl}${playback.streamUrl}`, {
      Cookie: stack.srv.admin.cookie!,
    });
    expect(status).toBe(200);
    expect(contentType).toBe('video/mp2t');
    for (let off = 0; off < 188 * 10; off += 188) expect(bytes[off]).toBe(0x47);
  });

  it('reconnexion au même flux : un nouveau lien est résolu, la lecture reprend', async () => {
    stack = await startStack({ channelCount: 50 });
    const playback = await start(stack);
    const url = `${stack.srv.baseUrl}${playback.streamUrl}`;
    const headers = { Cookie: stack.srv.admin.cookie! };
    expect((await firstBytes(url, headers)).status).toBe(200);
    // Le lien amont TS est à usage unique : le backend doit en redemander un.
    expect((await firstBytes(url, headers)).status).toBe(200);
  });

  it('token expiré côté portail : renouvelé de façon transparente', async () => {
    stack = await startStack({ channelCount: 50 });
    await stack.srv.admin.get(`/api/portals/${stack.portalDto.id}/channels`);
    await sendChaos(stack.portal.baseUrl, 'expire-token');
    const playback = await start(stack, '3');
    expect(
      (await firstBytes(`${stack.srv.baseUrl}${playback.streamUrl}`, { Cookie: stack.srv.admin.cookie! }))
        .status,
    ).toBe(200);
  });

  it('flux HLS : playlist réécrite vers le backend, segments relayés', async () => {
    stack = await startStack({ channelCount: 50, streamFormat: 'm3u8' });
    const playback = await start(stack);
    expect(playback.format).toBe('hls');
    const playlist = await stack.srv.admin.get(playback.streamUrl);
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(playlist.text).toContain('#EXT-X-MEDIA-SEQUENCE:');
    expect(playlist.text).not.toMatch(/play_token|\.ts\?|127\.0\.0\.1|http:/);
    const segments = playlist.text.split('\n').filter((l) => l.startsWith('/api/playback/'));
    expect(segments).toHaveLength(6);
    const segment = await fetch(`${stack.srv.baseUrl}${segments.at(-1)!}`, {
      headers: { Cookie: stack.srv.admin.cookie! },
    });
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toBe('video/mp2t');
    const bytes = Buffer.from(await segment.arrayBuffer());
    expect(bytes.length % 188).toBe(0);
    expect(bytes[0]).toBe(0x47);
    // Les rafraîchissements de playlist réutilisent le lien : pas de create_link à chaque fois.
    expect((await stack.srv.admin.get(playback.streamUrl)).status).toBe(200);
  });

  it('chaîne inconnue : erreur claire', async () => {
    stack = await startStack({ channelCount: 50 });
    const res = await stack.srv.admin.post('/api/playback', {
      portalId: stack.portalDto.id,
      channelId: '999999',
    });
    expect(res.status).toBe(404);
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
    await stack.srv.admin.post('/api/users', { username: 'voisin', password: 'voisin-password' });
    const other = stack.srv.client();
    await other.login('voisin', 'voisin-password');
    expect((await other.get(playback.streamUrl)).status).toBe(404);
    expect((await other.delete(`/api/playback/${playback.sessionId}`)).status).toBe(404);
  });

  it('coupure du client : la connexion amont est fermée (une MAC = peu de connexions)', async () => {
    stack = await startStack({ channelCount: 50 });
    const playback = await start(stack, '4');
    await firstBytes(`${stack.srv.baseUrl}${playback.streamUrl}`, { Cookie: stack.srv.admin.cookie! });
    await delay(500);
    const state = (await (await fetch(`${stack.portal.baseUrl}/_chaos/state`)).json()) as {
      activeStreams: Record<string, number>;
    };
    expect(state.activeStreams['4'] ?? 0).toBe(0);
  });
});

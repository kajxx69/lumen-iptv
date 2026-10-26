import type { PlaybackDto } from '@lumen/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, PORTAL_MAC, type Stack, firstBytes, sendChaos, startStack } from './helpers.js';

describe('sécurité HTTP et journaux', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack(
      { channelCount: 50, requireDoAuth: true, login: 'abonne', password: 'abonnement-secret' },
      {},
      { login: 'abonne', password: 'abonnement-secret' },
    );
  }, 120_000);
  afterAll(async () => stack.close());

  it('en-têtes de sécurité et CSP stricte sur toutes les réponses', async () => {
    for (const path of ['/', '/api/health', '/api/auth/me']) {
      const res = await fetch(`${stack.srv.baseUrl}${path}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-eval|unsafe-inline/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('les réponses d API ne sont pas mises en cache par des intermédiaires', async () => {
    const res = await stack.srv.admin.get('/api/auth/me');
    expect(res.headers.get('cache-control')).toMatch(/no-store|private/);
  });

  it('aucun secret dans les journaux, même après pannes et renouvellements', async () => {
    const portalId = stack.portalDto.id;
    await stack.srv.admin.get(`/api/portals/${portalId}/channels`);
    await sendChaos(stack.portal.baseUrl, 'expire-token');
    const res = await stack.srv.admin.post<PlaybackDto>('/api/playback', { portalId, channelId: '2' });
    await firstBytes(`${stack.srv.baseUrl}${res.body.streamUrl}`, { Cookie: stack.srv.admin.cookie! });
    await stack.srv.client().login(ADMIN.username, 'tentative-ratee');
    await stack.srv.admin.post('/api/portals', {
      name: 'Faux',
      url: `${stack.portal.baseUrl}/c/`,
      mac: PORTAL_MAC,
      login: 'abonne',
      password: 'mauvais-secret',
    });

    const logs = stack.srv.logs.join('\n');
    expect(stack.srv.logs.length).toBeGreaterThan(10);
    const sessionCookie = stack.srv.admin.cookie!.split('=')[1]!;
    for (const secret of [
      PORTAL_MAC,
      encodeURIComponent(PORTAL_MAC),
      'abonnement-secret',
      'mauvais-secret',
      ADMIN.password,
      'tentative-ratee',
      sessionCookie,
      'play_token',
      stack.srv.config.masterKey,
    ]) {
      expect(logs, `journal contenant « ${secret} »`).not.toContain(secret);
    }
  });

  it('chaque lecture porte un identifiant de corrélation dans les journaux', async () => {
    const res = await stack.srv.admin.post<PlaybackDto>('/api/playback', {
      portalId: stack.portalDto.id,
      channelId: '5',
    });
    await firstBytes(`${stack.srv.baseUrl}${res.body.streamUrl}`, { Cookie: stack.srv.admin.cookie! });
    const tagged = stack.srv.logs.filter((l) => l.includes(`"cid":"${res.body.sessionId}"`));
    expect(tagged.length).toBeGreaterThanOrEqual(2);
  });

  it('les erreurs ne divulguent ni l URL du portail ni la pile', async () => {
    await stack.portal.close();
    const res = await stack.srv.admin.post('/api/playback', { portalId: stack.portalDto.id, channelId: '1' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(new URL(stack.portal.baseUrl).host);
    expect(res.text).not.toMatch(/at \w+ \(|node_modules/);
  });
});

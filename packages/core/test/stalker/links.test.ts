import { afterEach, describe, expect, it } from 'vitest';
import { StalkerError } from '../../stalker/index.js';
import { type Harness, firstBytes, harness, sendChaos } from './helpers.js';

const LIVE_CMD = (id: number): string => `ffmpeg http://localhost/ch/${id}_`;

const rejection = async (p: Promise<unknown>): Promise<StalkerError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StalkerError);
    return err as StalkerError;
  }
  throw new Error('la promesse aurait dû échouer');
};

/** create_link est sur le chemin critique : chaque lecture et chaque reconnexion en dépendent. */
describe('client Stalker : résolution des liens (create_link)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('renvoie une URL nettoyée de son préfixe, lisible immédiatement', async () => {
    h = await harness({ linkPrefixMode: 'mixed' });
    for (const id of [1, 2, 3, 4, 5]) {
      const link = await h.client.createLink(LIVE_CMD(id));
      expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/play\/live\.php\?/);
      expect(link.format).toBe('ts');
      expect(link.resolvedAt).toBeLessThanOrEqual(Date.now());
    }
    const { status, bytes } = await firstBytes((await h.client.createLink(LIVE_CMD(1))).url);
    expect(status).toBe(200);
    expect(bytes[0]).toBe(0x47);
  });

  it('n est jamais mis en cache : chaque appel produit un nouveau lien', async () => {
    h = await harness();
    const a = await h.client.createLink(LIVE_CMD(1));
    const b = await h.client.createLink(LIVE_CMD(1));
    expect(a.url).not.toBe(b.url);
    expect(h.runtime.http.count('create_link')).toBe(2);
  });

  it('détecte le format HLS', async () => {
    h = await harness({ streamFormat: 'm3u8' });
    expect((await h.client.createLink(LIVE_CMD(1))).format).toBe('hls');
  });

  it('token expiré : renouvellement transparent, le nouveau lien est lisible', async () => {
    h = await harness();
    await h.client.authenticate();
    await sendChaos(h.portal.baseUrl, 'expire-token');
    const link = await h.client.createLink(LIVE_CMD(3));
    expect((await firstBytes(link.url)).status).toBe(200);
  });

  it('403 passager : nouveau handshake puis succès', async () => {
    h = await harness({ apiRateLimitPerSecond: 1000 }, { tuning: { rateLimitPerSecond: 100 } });
    await h.client.authenticate();
    await sendChaos(h.portal.baseUrl, 'http-error', { code: 403, probability: 0.5, scope: 'api', seed: 2 });
    const link = await h.client.createLink(LIVE_CMD(3));
    expect(link.url).toContain('play_token=');
  });

  it('chaîne inconnue : erreur typée nothing_to_play, sans relance', async () => {
    h = await harness();
    await h.client.authenticate();
    const err = await rejection(h.client.createLink(LIVE_CMD(999_999)));
    expect(err.kind).toBe('nothing_to_play');
    expect(h.runtime.http.count('create_link')).toBe(1);
  });

  it('portail lent : délai dépassé → erreur typée timeout, dans le temps imparti', async () => {
    h = await harness({}, { tuning: { requestTimeoutMs: 400, retryAttempts: 0 } });
    await h.client.authenticate();
    await sendChaos(h.portal.baseUrl, 'latency', { ms: 3000, scope: 'api' });
    const start = Date.now();
    const err = await rejection(h.client.createLink(LIVE_CMD(1)));
    expect(err.kind).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('erreurs passagères (5xx) : relances avec recul exponentiel', async () => {
    h = await harness({ apiRateLimitPerSecond: 1000 }, { tuning: { rateLimitPerSecond: 100 } });
    await h.client.authenticate();
    await sendChaos(h.portal.baseUrl, 'http-error', { code: 502, probability: 0.6, scope: 'api', seed: 9 });
    const link = await h.client.createLink(LIVE_CMD(2));
    expect(link.url).toMatch(/^http/);
    expect(h.runtime.http.requests.some((r) => r.status === 502)).toBe(true);
  });

  it('portail injoignable : erreur typée network', async () => {
    h = await harness({}, { tuning: { retryAttempts: 1 } });
    await h.client.authenticate();
    await h.portal.close();
    const err = await rejection(h.client.createLink(LIVE_CMD(1)));
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
  });
});

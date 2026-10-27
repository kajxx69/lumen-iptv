import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type RunningPortal,
  StalkerTestClient,
  TsCapture,
  chaos,
  delay,
  startPortal,
  tryConnect,
} from './helpers.js';

/**
 * Chaque scénario est observé de l'extérieur, comme le verra le backend Lumen :
 * temps de réponse, sockets coupées, codes HTTP, débit mesuré.
 */
describe('API de chaos : pannes réseau', () => {
  let portal: RunningPortal;
  let client: StalkerTestClient;

  beforeAll(async () => {
    portal = await startPortal({ apiRateLimitPerSecond: 10_000 });
  });
  afterAll(async () => portal.close());
  beforeEach(async () => {
    await chaos(portal.baseUrl, 'reset');
    client = new StalkerTestClient(portal.baseUrl);
    await client.handshake();
  });

  const timed = async <T>(fn: () => Promise<T>): Promise<number> => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };

  describe('latency', () => {
    it('scope api : chaque appel au portail est retardé', async () => {
      const LATENCY_MS = 800;
      expect(await timed(() => client.call('stb', 'get_profile'))).toBeLessThan(LATENCY_MS / 2);
      await chaos(portal.baseUrl, 'latency', { ms: LATENCY_MS, scope: 'api' });
      expect(await timed(() => client.call('stb', 'get_profile'))).toBeGreaterThanOrEqual(LATENCY_MS - 20);
    });

    it('scope stream : le premier octet du flux arrive en retard, l API reste rapide', async () => {
      const LATENCY_MS = 1000;
      await chaos(portal.baseUrl, 'latency', { ms: LATENCY_MS, scope: 'stream' });
      expect(await timed(() => client.call('stb', 'get_profile'))).toBeLessThan(LATENCY_MS / 2);
      const capture = await TsCapture.open(await client.liveUrl(1));
      await delay(300);
      capture.close();
      expect(capture.firstByteAt! - capture.openedAt).toBeGreaterThanOrEqual(LATENCY_MS - 20);
    });
  });

  describe('drop', () => {
    it('coupe les flux de la chaîne visée, refuse les reconnexions, puis rétablit', async () => {
      const DROP_MS = 2500;
      const target = await TsCapture.open(await client.liveUrl(42));
      const bystander = await TsCapture.open(await client.liveUrl(43));
      await delay(500);
      expect(target.bytes).toBeGreaterThan(0);

      const droppedAt = Date.now();
      await chaos(portal.baseUrl, 'drop', { durationMs: DROP_MS, channelId: '42' });
      expect(await target.waitClosed(500)).toBe(true);
      expect(target.closedAt! - droppedAt).toBeLessThan(500);

      // Pendant la coupure : socket réinitialisée, pas de réponse HTTP.
      expect(await tryConnect(await client.liveUrl(42))).toHaveProperty('error');
      // Les autres chaînes continuent.
      const bystanderBytes = bystander.bytes;
      await delay(500);
      expect(bystander.closedAt).toBeUndefined();
      expect(bystander.bytes).toBeGreaterThan(bystanderBytes);
      bystander.close();

      await delay(DROP_MS - (Date.now() - droppedAt) + 100);
      const recovered = await TsCapture.open(await client.liveUrl(42));
      expect(recovered.status).toBe(200);
      await delay(300);
      expect(recovered.bytes).toBeGreaterThan(0);
      recovered.close();
    });

    it('sans channelId, coupe toutes les chaînes', async () => {
      const a = await TsCapture.open(await client.liveUrl(1));
      const b = await TsCapture.open(await client.liveUrl(2));
      await chaos(portal.baseUrl, 'drop', { durationMs: 1000 });
      expect(await a.waitClosed(500)).toBe(true);
      expect(await b.waitClosed(500)).toBe(true);
    });
  });

  describe('expire-token', () => {
    it('invalide les tokens et coupe les flux en cours ; un nouveau handshake suffit', async () => {
      const capture = await TsCapture.open(await client.liveUrl(5));
      await delay(300);
      const freshUrl = await client.liveUrl(6);
      await chaos(portal.baseUrl, 'expire-token');
      expect(await capture.waitClosed(500)).toBe(true);
      expect((await client.raw({ type: 'stb', action: 'get_profile' })).status).toBe(401);
      // Les liens émis avant l'expiration sont morts aussi.
      expect(await tryConnect(freshUrl)).toEqual({ status: 403 });
      await client.handshake();
      expect((await client.raw({ type: 'stb', action: 'get_profile' })).status).toBe(200);
      const again = await TsCapture.open(await client.liveUrl(5));
      expect(again.status).toBe(200);
      again.close();
    });

    it('killStreams=false laisse filer les flux déjà ouverts', async () => {
      const capture = await TsCapture.open(await client.liveUrl(5));
      await chaos(portal.baseUrl, 'expire-token', { killStreams: false });
      expect(await capture.waitClosed(500)).toBe(false);
      expect((await client.raw({ type: 'stb', action: 'get_profile' })).status).toBe(401);
      capture.close();
    });
  });

  describe('http-error', () => {
    it('probabilité 1 : toute requête API et flux reçoit le code injecté', async () => {
      const url = await client.liveUrl(1);
      await chaos(portal.baseUrl, 'http-error', { code: 403, probability: 1 });
      expect((await client.raw({ type: 'stb', action: 'get_profile' })).status).toBe(403);
      expect(await tryConnect(url)).toEqual({ status: 403 });
    });

    it('probabilité 0,3 : environ 30 % d échecs, tirage reproductible avec une graine', async () => {
      const REQUESTS = 300;
      const run = async (): Promise<number[]> => {
        await chaos(portal.baseUrl, 'http-error', { code: 503, probability: 0.3, scope: 'api', seed: 7 });
        const statuses: number[] = [];
        for (let i = 0; i < REQUESTS; i++)
          statuses.push((await client.raw({ type: 'stb', action: 'get_profile' })).status);
        return statuses;
      };
      const first = await run();
      const rate = first.filter((s) => s === 503).length / REQUESTS;
      expect(rate).toBeGreaterThan(0.22);
      expect(rate).toBeLessThan(0.38);
      expect(first.every((s) => s === 503 || s === 200)).toBe(true);
      expect(await run()).toEqual(first);
    });

    it('scope stream : l API reste saine', async () => {
      await chaos(portal.baseUrl, 'http-error', { code: 502, probability: 1, scope: 'stream' });
      const url = await client.liveUrl(1);
      expect(await tryConnect(url)).toEqual({ status: 502 });
    });
  });

  describe('throttle', () => {
    it('plafonne le débit du flux, bien en dessous de son débit nominal', async () => {
      const THROTTLE_KBPS = 300;
      const MEASURE_MS = 3000;
      const kbps = (bytes: number): number => (bytes * 8) / MEASURE_MS;

      const nominal = await TsCapture.open(await client.liveUrl(7));
      // On laisse passer la rafale initiale avant de mesurer le régime établi.
      await delay(600);
      const n0 = nominal.bytes;
      await delay(MEASURE_MS);
      const nominalKbps = kbps(nominal.bytes - n0);
      nominal.close();

      await chaos(portal.baseUrl, 'throttle', { bitrateKbps: THROTTLE_KBPS });
      const throttled = await TsCapture.open(await client.liveUrl(7));
      await delay(600);
      const t0 = throttled.bytes;
      await delay(MEASURE_MS);
      const throttledKbps = kbps(throttled.bytes - t0);
      throttled.close();

      expect(nominalKbps).toBeGreaterThan(THROTTLE_KBPS * 3);
      expect(throttledKbps).toBeLessThan(THROTTLE_KBPS * 1.15);
      expect(throttledKbps).toBeGreaterThan(THROTTLE_KBPS * 0.7);
    });
  });

  describe('reset', () => {
    it('remet le portail en état nominal après un cumul de pannes', async () => {
      await chaos(portal.baseUrl, 'latency', { ms: 2000, scope: 'api' });
      await chaos(portal.baseUrl, 'http-error', { code: 500, probability: 1, scope: 'stream' });
      await chaos(portal.baseUrl, 'throttle', { bitrateKbps: 50 });
      await chaos(portal.baseUrl, 'corrupt', { segmentProbability: 1 });
      await chaos(portal.baseUrl, 'freeze', { durationMs: 60_000 });
      await chaos(portal.baseUrl, 'blackscreen', { durationMs: 60_000 });
      await chaos(portal.baseUrl, 'drop', { durationMs: 60_000, channelId: '9' });
      await chaos(portal.baseUrl, 'reset');

      const state = (await (await fetch(`${portal.baseUrl}/_chaos/state`)).json()) as Record<string, unknown>;
      expect(state).toMatchObject({
        latencyMs: { api: 0, stream: 0 },
        httpError: null,
        throttleKbps: null,
        corruptSegmentProbability: 0,
        drops: [],
        freezes: [],
        blackscreens: [],
      });
      expect(await timed(() => client.call('stb', 'get_profile'))).toBeLessThan(500);
      const capture = await TsCapture.open(await client.liveUrl(9));
      expect(capture.status).toBe(200);
      capture.close();
    });

    it('rejette un corps invalide avec 400', async () => {
      const res = await fetch(`${portal.baseUrl}/_chaos/http-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 200, probability: 2 }),
      });
      expect(res.status).toBe(400);
    });
  });
});

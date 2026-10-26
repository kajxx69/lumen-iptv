import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceProvider } from '../../sources/index.js';
import { StalkerProvider } from '../../stalker/index.js';
import { TEST_MAC, collect, firstBytes, nodeRuntime, type RunningPortal, startPortal } from './helpers.js';

/** StalkerProvider vu par le reste du système : uniquement l'interface abstraite. */
describe('StalkerProvider (interface SourceProvider)', () => {
  let portal: RunningPortal;
  let provider: SourceProvider & { close(): void };

  beforeAll(async () => {
    portal = await startPortal({ channelCount: 120, vodCount: 40 });
    provider = new StalkerProvider(
      { id: 'portail-test', portalUrl: `${portal.baseUrl}/c/`, mac: TEST_MAC },
      nodeRuntime(),
    );
  });
  afterAll(async () => {
    provider.close();
    await portal.close();
  });

  it('authenticate ouvre une session sans exposer de secret', async () => {
    const session = await provider.authenticate();
    expect(session).toMatchObject({ providerId: 'portail-test', status: 'active' });
    expect(JSON.stringify(session)).not.toContain(TEST_MAC);
  });

  it('listChannels produit des chaînes normalisées, rattachées au fournisseur', async () => {
    const channels = await collect(provider.listChannels());
    expect(channels).toHaveLength(120);
    expect(channels[0]).toMatchObject({
      providerId: 'portail-test',
      id: '1',
      number: 1,
      stream: { kind: 'live', providerId: 'portail-test' },
    });
    expect(channels.some((c) => c.logoUrl === null)).toBe(true);
  });

  it('listVod produit des fiches normalisées', async () => {
    const vod = await collect(provider.listVod());
    expect(vod).toHaveLength(40);
    expect(vod[0]?.stream.kind).toBe('vod');
  });

  it('resolveStream résout un lien neuf, lisible', async () => {
    const [channel] = await collect(provider.listChannels());
    const a = await provider.resolveStream(channel!.stream);
    const b = await provider.resolveStream(channel!.stream);
    expect(a.url).not.toBe(b.url);
    expect(a.format).toBe('ts');
    expect((await firstBytes(a.url)).bytes[0]).toBe(0x47);
  });

  it('getEpg couvre la fenêtre demandée', async () => {
    const now = Date.now();
    const epg = await provider.getEpg('1', { from: now, to: now + 4 * 3_600_000 });
    expect(epg[0]!.start).toBeLessThanOrEqual(now);
    expect(epg.at(-1)!.end).toBeGreaterThanOrEqual(now + 4 * 3_600_000);
    expect(epg[0]).toMatchObject({ channelId: '1', title: expect.any(String) });
  });

  it('capabilities décrit ce que le portail sait faire', () => {
    expect(provider.capabilities()).toEqual({
      live: true,
      vod: true,
      series: true,
      radio: true,
      epg: true,
      archive: true,
      favorites: true,
    });
  });
});

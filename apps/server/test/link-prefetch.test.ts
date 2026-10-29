import { describe, expect, it } from 'vitest';
import { LinkPrefetcher } from '../src/playback/link-prefetch.js';
import type { UpstreamLink } from '../src/relay/upstream.js';

const link = (n: number): UpstreamLink => ({
  url: `http://portail/flux/${n}`,
  format: 'ts',
  userAgent: 'MAG',
});

describe('liens des chaînes voisines demandés à l avance', () => {
  it('un lien frais sert une seule fois', async () => {
    const p = new LinkPrefetcher(20_000);
    await p.prefetch('a:1', () => Promise.resolve(link(1)));
    expect(p.take('a:1')).toEqual(link(1));
    expect(p.take('a:1')).toBeNull();
  });

  it('un lien trop vieux (jeton expiré) est oublié', async () => {
    let now = 0;
    const p = new LinkPrefetcher(20_000, () => now);
    await p.prefetch('a:1', () => Promise.resolve(link(1)));
    now = 20_001;
    expect(p.take('a:1')).toBeNull();
  });

  it('pas de seconde demande au portail pour un lien encore frais ou en cours', async () => {
    const p = new LinkPrefetcher(20_000);
    let calls = 0;
    const resolve = (): Promise<UpstreamLink> => {
      calls++;
      return new Promise((r) => setTimeout(() => r(link(calls)), 10));
    };
    await Promise.all([p.prefetch('a:1', resolve), p.prefetch('a:1', resolve)]);
    await p.prefetch('a:1', resolve);
    expect(calls).toBe(1);
  });

  it('un refus du portail est sans conséquence : le zapping demandera le lien lui-même', async () => {
    const p = new LinkPrefetcher(20_000);
    await p.prefetch('a:1', () => Promise.reject(new Error('refus')));
    expect(p.take('a:1')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { ChannelSearch, type SearchableChannel } from '../src/catalog/search.js';

const channel = (key: string, name: string, number = 0): SearchableChannel => ({ key, name, number });

describe('recherche locale des chaînes', () => {
  const search = new ChannelSearch([
    channel('p:1', 'FR | CANAL+ FHD', 4),
    channel('p:2', 'FR | TF1 HD', 1),
    channel('p:3', 'FR | France 24', 24),
    channel('p:4', '|AR| Al Jazeera', 300),
    channel('p:5', 'Télé Monte-Carlo', 51),
    channel('p:6', 'CANAL PLUS Sport', 40),
  ]);

  it('préfixe : quelques lettres suffisent', () => {
    expect(search.search('can')).toEqual(expect.arrayContaining(['p:1', 'p:6']));
  });

  it('insensible aux accents, à la casse et aux marqueurs de qualité', () => {
    expect(search.search('TELE monte')).toEqual(['p:5']);
    expect(search.search('tf1 hd')).toEqual(['p:2']);
  });

  it('tolère une faute de frappe sur un mot long', () => {
    expect(search.search('jazera')).toEqual(['p:4']);
  });

  it('tous les mots doivent correspondre', () => {
    expect(search.search('canal sport')).toEqual(['p:6']);
  });

  it('par numéro de chaîne', () => {
    expect(search.search('24')[0]).toBe('p:3');
  });

  it('requête vide : aucun résultat', () => {
    expect(search.search('   ')).toEqual([]);
  });

  it('100 000 entrées : chaque recherche en moins de 50 ms', () => {
    const words = ['sport', 'news', 'cinema', 'kids', 'music', 'canal', 'tele', 'africa', 'info', 'series'];
    const big: SearchableChannel[] = Array.from({ length: 100_000 }, (_, i) =>
      channel(`p:${i}`, `FR | ${words[i % 10]!} ${words[(i * 7) % 10]!} ${i} HD`, i),
    );
    const index = new ChannelSearch(big);
    const queries = ['spo', 'canal info', 'cinema 4521', 'afrika', 'tele kids', 'zzz'];
    for (const q of queries) index.search(q); // échauffement du JIT
    const timings = queries.map((q) => {
      const t0 = performance.now();
      index.search(q);
      return performance.now() - t0;
    });
    console.log('recherche sur 100 000 entrées (ms) :', timings.map((t) => t.toFixed(1)).join(' / '));
    expect(Math.max(...timings)).toBeLessThan(50);
  });
});

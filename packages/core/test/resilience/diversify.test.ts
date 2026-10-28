import { describe, expect, it } from 'vitest';
import { diversifyHosts } from '../../resilience/index.js';

const src = (id: string, host: string) => ({ id, host });
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('ordre de bascule : alterner les serveurs', () => {
  it('après la meilleure source, la suivante vient d un autre serveur', () => {
    const ranked = [src('A1', 'a'), src('A2', 'a'), src('B1', 'b'), src('A3', 'a'), src('B2', 'b')];
    expect(ids(diversifyHosts(ranked, (s) => s.host))).toEqual(['A1', 'B1', 'A2', 'B2', 'A3']);
  });

  it('un seul serveur : l ordre du classement est gardé', () => {
    const ranked = [src('A1', 'a'), src('A2', 'a'), src('A3', 'a')];
    expect(ids(diversifyHosts(ranked, (s) => s.host))).toEqual(['A1', 'A2', 'A3']);
  });

  it('serveurs déjà alternés : rien ne change', () => {
    const ranked = [src('A1', 'a'), src('B1', 'b'), src('C1', 'c')];
    expect(ids(diversifyHosts(ranked, (s) => s.host))).toEqual(['A1', 'B1', 'C1']);
  });

  it('liste vide', () => {
    expect(diversifyHosts([], () => '')).toEqual([]);
  });
});

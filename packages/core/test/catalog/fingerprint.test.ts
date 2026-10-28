import { describe, expect, it } from 'vitest';
import { GRID_MATCH, compareGrids, fingerprintName } from '../../catalog/index.js';

describe('empreinte de nom (rapprochement entre portails)', () => {
  it.each([
    ['FR | NOVA TV FHD', 'nova tv'],
    ['Nova TV France 1080', 'nova tv'],
    ['Nova Afrique Côte d’Ivoire HD', 'nova afrique'],
    ['Nova TV 2 Sénégal', 'nova tv 2'],
    ['CANAL PLUS France', 'canal+'],
    ['FR | CANAL+ FHD', 'canal+'],
    ['Canal + HD', 'canal+'],
    ['TV5 Monde FR', 'tv5 monde'],
    ['Info États-Unis', 'info'],
  ])('%s → %s', (input, expected) => {
    expect(fingerprintName(input)).toBe(expected);
  });

  it('un pays en tête fait partie du nom (France 24, France 2)', () => {
    expect(fingerprintName('France 24')).toBe('france 24');
    expect(fingerprintName('FR | France 2 HD')).toBe('france 2');
  });

  it('un nom fait seulement d un pays reste reconnaissable', () => {
    expect(fingerprintName('Sénégal')).toBe('senegal');
  });
});

const H = 3_600_000;
const M = 60_000;
const FROM = 1_700_000_000_000;

const grid = (titles: string[], slotMs = H, offsetMs = 0) =>
  titles.map((title, i) => ({
    title,
    start: FROM + offsetMs + i * slotMs,
    end: FROM + offsetMs + (i + 1) * slotMs,
  }));

const SIX = ['Journal', 'Météo', 'Série : Le Retour', 'Film : Nuit', 'Débat', 'Journal du soir'];

describe('similarité des grilles de programmes sur 6 h', () => {
  it('même grille : identique', () => {
    const r = compareGrids(grid(SIX), grid(SIX), FROM);
    expect(r.similarity).toBe(1);
    expect(r.verdict).toBe('same');
  });

  it('casse, accents et léger décalage horaire ne séparent pas deux grilles identiques', () => {
    const other = grid(
      SIX.map((t) => t.toUpperCase().replace('É', 'E')),
      H,
      2 * M,
    );
    const r = compareGrids(grid(SIX), other, FROM);
    expect(r.similarity).toBeGreaterThan(0.9);
    expect(r.verdict).toBe('same');
  });

  it('programmes différents : chaînes différentes', () => {
    const r = compareGrids(grid(SIX), grid(['A', 'B', 'C', 'D', 'E', 'F']), FROM);
    expect(r.similarity).toBe(0);
    expect(r.verdict).toBe('different');
  });

  it('grille absente ou trop courte : aucun avis', () => {
    expect(compareGrids(grid(SIX), [], FROM)).toEqual({ similarity: null, verdict: null });
    const short = compareGrids(grid(SIX), grid(['Journal']), FROM);
    expect(short.verdict).toBeNull();
  });

  it('ressemblance partielle : aucun avis tranché', () => {
    const half = grid(['Journal', 'Météo', 'Série : Le Retour', 'X', 'Y', 'Z']);
    const r = compareGrids(grid(SIX), half, FROM);
    expect(r.similarity).toBeCloseTo(0.5, 1);
    expect(r.verdict).toBeNull();
    expect(GRID_MATCH.sameAt).toBeGreaterThan(0.5);
  });
});

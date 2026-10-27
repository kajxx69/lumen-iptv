import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../catalog/index.js';

describe('normalisation des noms de chaînes', () => {
  it.each([
    ['FR | CANAL+ FHD', 'canal+'],
    ['FR: TF1 HD', 'tf1'],
    ['|AR| Al Jazeera', 'al jazeera'],
    ['[UK] BBC One 4K', 'bbc one'],
    ['DE - Das Erste HEVC', 'das erste'],
    ['C+ 1080', 'c+'],
    ['CANAL PLUS France', 'canal plus france'],
    ['Télé Monte-Carlo', 'tele monte carlo'],
    ['RTI 1 (1080p)', 'rti 1'],
    ['  Équipe   21  ', 'equipe 21'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it('un nom fait seulement de marqueurs reste reconnaissable', () => {
    expect(normalizeName('HD')).toBe('hd');
  });

  it('un mot qui commence comme un pays n est pas un préfixe', () => {
    expect(normalizeName('France 24')).toBe('france 24');
    expect(normalizeName('ARTE')).toBe('arte');
  });
});

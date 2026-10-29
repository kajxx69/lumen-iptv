import { describe, expect, it } from 'vitest';
import { repairLink } from '../../stalker/links.js';

/**
 * Portails Stalker adossés à Xtream : la commande du catalogue est déjà une adresse complète
 * (`http://hôte/utilisateur/mot-de-passe/flux`). Certains, à create_link, la recollent de
 * travers (un bout de l'hôte au milieu du chemin, le chemin en double) : le serveur de flux
 * répond 401. Valeurs anonymisées, forme relevée sur un vrai portail.
 */
describe('liens recollés de travers par le portail', () => {
  const catalog = 'ffmpeg http://exemple.tv:80/UTILISATEUR/SECRET/1123275';

  it('chemin du catalogue recollé en double : la commande du catalogue, déjà complète, est jouée', () => {
    const broken =
      'http://exemple.tv/UTILISATEUR/SECRET/le.tv:80/UTILISATEUR/SECRET/1123275?play_token=abcdef1234';
    expect(repairLink(catalog, broken)).toBe('http://exemple.tv:80/UTILISATEUR/SECRET/1123275');
  });

  it('lien sain (même chemin, jeton ajouté) : gardé tel quel', () => {
    const good = 'http://exemple.tv:80/UTILISATEUR/SECRET/1123275?play_token=abcdef1234';
    expect(repairLink(catalog, good)).toBe(good);
  });

  it('commande « localhost » (le portail fabrique tout le lien) : lien gardé tel quel', () => {
    const link = 'http://flux.exemple.tv/play/live.php?mac=x&stream=12&play_token=t';
    expect(repairLink('ffmpeg http://localhost/ch/12_', link)).toBe(link);
  });

  it('lien vers un autre serveur de flux : gardé tel quel', () => {
    const link = 'http://cdn.ailleurs.tv/live/UTILISATEUR/SECRET/1123275.ts?token=t';
    expect(repairLink(catalog, link)).toBe(link);
  });

  it('commande sans adresse : lien gardé tel quel', () => {
    const link = 'http://exemple.tv/play/live.php?stream=1';
    expect(repairLink('auto /media/1.mpg', link)).toBe(link);
  });
});

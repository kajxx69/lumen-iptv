import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/security/passwords.js';
import { SecretBox } from '../src/security/secret-box.js';

const key = (): string => randomBytes(32).toString('base64');

describe('SecretBox : chiffrement au repos des identifiants de portail', () => {
  it('chiffre puis déchiffre', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('{"mac":"00:1A:79:AB:CD:EF"}', 'portal:1');
    expect(box.open(sealed, 'portal:1')).toBe('{"mac":"00:1A:79:AB:CD:EF"}');
  });

  it('ne laisse rien de lisible dans le chiffré', () => {
    const sealed = new SecretBox(key()).seal('00:1A:79:AB:CD:EF http://portail.example', 'portal:1');
    const raw = sealed.toString('latin1');
    expect(raw).not.toContain('00:1A:79');
    expect(raw).not.toContain('portail.example');
  });

  it('deux chiffrements du même texte diffèrent (IV aléatoire)', () => {
    const box = new SecretBox(key());
    expect(box.seal('x', 'a').equals(box.seal('x', 'a'))).toBe(false);
  });

  it('refuse une mauvaise clé, une altération ou un chiffré déplacé sur une autre ligne', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('secret', 'portal:1');
    expect(() => new SecretBox(key()).open(sealed, 'portal:1')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => box.open(tampered, 'portal:1')).toThrow();
    // L'identifiant de la ligne est authentifié : on ne peut pas échanger deux chiffrés.
    expect(() => box.open(sealed, 'portal:2')).toThrow();
  });

  it('refuse une clé maître de mauvaise taille', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('mots de passe', () => {
  it('hache avec sel et vérifie', async () => {
    const a = await hashPassword('mot-de-passe-long');
    const b = await hashPassword('mot-de-passe-long');
    expect(a).not.toBe(b);
    expect(a).not.toContain('mot-de-passe-long');
    expect(await verifyPassword('mot-de-passe-long', a)).toBe(true);
    expect(await verifyPassword('mauvais', a)).toBe(false);
    expect(await verifyPassword('x', 'format-invalide')).toBe(false);
  });
});

describe('configuration', () => {
  it('refuse de démarrer sans clé maître', () => {
    expect(() => configFromEnv({})).toThrow(/LUMEN_MASTER_KEY/);
    expect(() => configFromEnv({ LUMEN_MASTER_KEY: 'trop-courte' })).toThrow(/32 octets/);
  });

  it('lit les variables LUMEN_*', () => {
    const config = configFromEnv({
      LUMEN_MASTER_KEY: key(),
      LUMEN_PORT: '9000',
      LUMEN_COOKIE_SECURE: 'false',
    });
    expect(config.port).toBe(9000);
    expect(config.cookieSecure).toBe(false);
    expect(config.maxStreamsPerUser).toBe(4);
  });
});

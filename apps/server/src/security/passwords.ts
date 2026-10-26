import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Paramètres scrypt (OWASP) : ~50 ms par vérification, coût prohibitif pour une attaque hors ligne.
const SCRYPT_LOG_N = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
// N · r · 128 octets = 32 Mio ; marge pour l'allocation interne.
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { ...options, maxmem: SCRYPT_MAX_MEMORY }, (err, key) => {
      if (err === null) resolve(key);
      else reject(err);
    });
  });
}

/** Format auto-descriptif : `scrypt$logN$r$p$sel$empreinte`, paramètres modifiables plus tard. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N: 2 ** SCRYPT_LOG_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join(
    '$',
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), {
    N: 2 ** Number(logN),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Empreinte factice : vérifier un utilisateur inexistant coûte autant qu'un vrai, pour ne
 * pas révéler par le temps de réponse quels comptes existent.
 */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString('hex'));

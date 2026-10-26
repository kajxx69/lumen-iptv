import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
// Une clé dérivée par usage : la clé maître pourra servir à autre chose sans réutilisation.
const KEY_INFO = 'lumen/portal-secrets/v1';

/**
 * Chiffrement authentifié (AES-256-GCM) des secrets de portail. Format :
 * version (1) | IV (12) | tag (16) | chiffré. Le contexte (identifiant de ligne) est
 * authentifié : un chiffré recopié sur une autre ligne est rejeté.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== KEY_BYTES) throw new RangeError('clé maître : 32 octets attendus');
    this.key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), KEY_INFO, KEY_BYTES));
  }

  seal(plaintext: string, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  /** Lève une erreur si la clé est fausse, le chiffré altéré ou le contexte différent. */
  open(sealed: Buffer, context: string): string {
    if (sealed.length < HEADER_BYTES || sealed[0] !== FORMAT_VERSION) throw new Error('secret illisible');
    const iv = sealed.subarray(1, 1 + IV_BYTES);
    const tag = sealed.subarray(1 + IV_BYTES, HEADER_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
  }
}

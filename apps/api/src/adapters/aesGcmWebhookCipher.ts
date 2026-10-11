import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { WebhookDecryptError, type WebhookCipher } from '../ports/webhookCipher.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // the size GCM is designed for; a fresh random one per message, never reused
const TAG_BYTES = 16;
/** First byte of every blob, so a future key rotation or algorithm change can tell old blobs from new. */
const FORMAT_VERSION = 1;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * AES-256-GCM (security-secrets skill). Stored layout: `version(1) | iv(12) | tag(16) | ciphertext`. The guild id
 * is authenticated as associated data, so a blob copied onto another server's row fails to decrypt.
 */
export class AesGcmWebhookCipher implements WebhookCipher {
  private readonly key: Buffer;

  /** @param keyBase64 32 random bytes, base64 (config.ts validates the shape before this runs). */
  public constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== KEY_BYTES) {
      throw new RangeError(`The webhook encryption key must be ${String(KEY_BYTES)} bytes.`);
    }
  }

  public encrypt(plaintext: string, guildId: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(guildId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  }

  public decrypt(blob: Buffer, guildId: string): string {
    if (blob.length <= HEADER_BYTES || blob[0] !== FORMAT_VERSION) {
      throw new WebhookDecryptError();
    }
    try {
      const iv = blob.subarray(1, 1 + IV_BYTES);
      const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
      const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(guildId, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(blob.subarray(HEADER_BYTES)),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // Node's message can name the failing step; callers get the one fixed error and nothing else.
      throw new WebhookDecryptError();
    }
  }
}

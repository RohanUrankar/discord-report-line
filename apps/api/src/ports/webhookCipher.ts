/** Thrown by `decrypt` for anything unreadable: wrong key, wrong guild, tampering, truncation. */
export class WebhookDecryptError extends Error {
  public constructor() {
    // Fixed text: nothing about the ciphertext, the key or the plaintext can be learned from it.
    super('The stored mirror webhook could not be decrypted.');
    this.name = 'WebhookDecryptError';
  }
}

/**
 * Encrypts the per-server Slack webhook URL for storage (DESIGN §9, "Secrets at rest"). The guild id is
 * bound in as associated data, so one server's blob cannot be copied onto another server's row.
 */
export interface WebhookCipher {
  encrypt(plaintext: string, guildId: string): Buffer;
  /** @throws WebhookDecryptError */
  decrypt(blob: Buffer, guildId: string): string;
}

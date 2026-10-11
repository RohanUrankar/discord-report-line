/** Where a server's encrypted Slack webhook lives (`guild.mirror_webhook_enc`, DESIGN §9). */
export interface MirrorWebhookStore {
  /** Stores the ciphertext, creating the server's row if no interaction has created it yet. */
  save(guildId: string, encrypted: Buffer): Promise<void>;
}

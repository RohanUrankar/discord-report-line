import type pg from 'pg';

import type { MirrorWebhookStore } from '../../ports/mirrorWebhookStore.js';

const SAVE_WEBHOOK = `
  INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2)
  ON CONFLICT (id) DO UPDATE SET mirror_webhook_enc = EXCLUDED.mirror_webhook_enc`;

export class PgMirrorWebhookStore implements MirrorWebhookStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async save(guildId: string, encrypted: Buffer): Promise<void> {
    await this.pool.query(SAVE_WEBHOOK, [guildId, encrypted]);
  }
}

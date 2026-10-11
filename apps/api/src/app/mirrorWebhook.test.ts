import { describe, expect, it } from 'vitest';

import { AesGcmWebhookCipher } from '../adapters/aesGcmWebhookCipher.js';
import type { MirrorWebhookStore } from '../ports/mirrorWebhookStore.js';
import { saveMirrorWebhook } from './mirrorWebhook.js';

const PREFIX = 'https://hooks.slack.com/services/';
const GUILD = '900000000000000001';
const URL_OK = `${PREFIX}T000/B000/abcdEFGH`;
const cipher = new AesGcmWebhookCipher(Buffer.alloc(32, 5).toString('base64'));

class FakeStore implements MirrorWebhookStore {
  public readonly saved: { guildId: string; encrypted: Buffer }[] = [];

  public save(guildId: string, encrypted: Buffer): Promise<void> {
    this.saved.push({ guildId, encrypted });
    return Promise.resolve();
  }
}

describe('saveMirrorWebhook', () => {
  it('WHEN the URL is a Slack webhook THE SYSTEM SHALL store it encrypted, bound to the server', async () => {
    const store = new FakeStore();

    const result = await saveMirrorWebhook(
      { guildId: GUILD, url: URL_OK, allowedPrefix: PREFIX },
      { cipher, store },
    );

    expect(result).toEqual({ ok: true, endsIn: 'EFGH' });
    expect(store.saved).toHaveLength(1);
    const [saved] = store.saved;
    expect(saved?.encrypted.toString('latin1')).not.toContain('hooks.slack.com');
    expect(cipher.decrypt(saved?.encrypted ?? Buffer.alloc(0), GUILD)).toBe(URL_OK);
  });

  it.each([
    ['another host', 'https://example.com/services/T/B/x'],
    ['plain http', 'http://hooks.slack.com/services/T/B/x'],
    ['an internal address', 'http://169.254.169.254/'],
    ['empty input', ''],
  ])('WHEN the URL is %s THE SYSTEM SHALL reject it and store nothing', async (_label, url) => {
    const store = new FakeStore();

    const result = await saveMirrorWebhook(
      { guildId: GUILD, url, allowedPrefix: PREFIX },
      { cipher, store },
    );

    expect(result).toEqual({ ok: false, reason: 'not_allowed' });
    expect(store.saved).toEqual([]);
  });

  it('SHALL return only the last four characters, never the URL', async () => {
    const result = await saveMirrorWebhook(
      { guildId: GUILD, url: URL_OK, allowedPrefix: PREFIX },
      { cipher, store: new FakeStore() },
    );

    expect(JSON.stringify(result)).not.toContain('hooks.slack.com');
  });
});

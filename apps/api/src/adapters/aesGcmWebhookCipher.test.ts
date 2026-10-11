import { describe, expect, it } from 'vitest';

import { WebhookDecryptError } from '../ports/webhookCipher.js';
import { AesGcmWebhookCipher } from './aesGcmWebhookCipher.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 4).toString('base64');
const GUILD = '900000000000000001';
const URL_SECRET = 'https://hooks.slack.com/services/T000/B000/fake-secret-do-not-leak';

const HEADER = { version: 0, iv: 1, tag: 13, data: 29 } as const;

function flipped(blob: Buffer, index: number): Buffer {
  const copy = Buffer.from(blob);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

describe('AesGcmWebhookCipher', () => {
  const cipher = new AesGcmWebhookCipher(KEY);

  it('SHALL decrypt what it encrypted', () => {
    expect(cipher.decrypt(cipher.encrypt(URL_SECRET, GUILD), GUILD)).toBe(URL_SECRET);
  });

  it('SHALL not contain the plaintext in the stored blob', () => {
    expect(cipher.encrypt(URL_SECRET, GUILD).toString('latin1')).not.toContain('hooks.slack.com');
  });

  it('SHALL use a fresh IV every time, so equal inputs give different blobs', () => {
    const first = cipher.encrypt(URL_SECRET, GUILD);
    const second = cipher.encrypt(URL_SECRET, GUILD);

    expect(first.equals(second)).toBe(false);
    expect(
      first.subarray(HEADER.iv, HEADER.tag).equals(second.subarray(HEADER.iv, HEADER.tag)),
    ).toBe(false);
  });

  it.each([
    ['the version byte', HEADER.version],
    ['the IV', HEADER.iv],
    ['the authentication tag', HEADER.tag],
    ['the ciphertext', HEADER.data],
  ])('WHEN %s is tampered with THE SYSTEM SHALL refuse to decrypt', (_part, index) => {
    const blob = cipher.encrypt(URL_SECRET, GUILD);

    expect(() => cipher.decrypt(flipped(blob, index), GUILD)).toThrow(WebhookDecryptError);
  });

  it('WHEN the blob is moved to another server THE SYSTEM SHALL refuse to decrypt (guild id is authenticated)', () => {
    const blob = cipher.encrypt(URL_SECRET, GUILD);

    expect(() => cipher.decrypt(blob, '900000000000000002')).toThrow(WebhookDecryptError);
  });

  it('WHEN the key is different THE SYSTEM SHALL refuse to decrypt', () => {
    const blob = cipher.encrypt(URL_SECRET, GUILD);

    expect(() => new AesGcmWebhookCipher(OTHER_KEY).decrypt(blob, GUILD)).toThrow(
      WebhookDecryptError,
    );
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['header only', Buffer.alloc(29, 1)],
    ['truncated', Buffer.alloc(10, 1)],
  ])('WHEN the blob is %s THE SYSTEM SHALL refuse to decrypt', (_label, blob) => {
    expect(() => cipher.decrypt(blob, GUILD)).toThrow(WebhookDecryptError);
  });

  it('SHALL fail with a fixed message that reveals neither the key, the URL nor the ciphertext', () => {
    const blob = flipped(cipher.encrypt(URL_SECRET, GUILD), HEADER.data);
    let message = '';
    try {
      cipher.decrypt(blob, GUILD);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toBe('The stored mirror webhook could not be decrypted.');
    expect(message).not.toContain(KEY);
  });

  it.each([[Buffer.alloc(16).toString('base64')], [Buffer.alloc(33).toString('base64')]])(
    'SHALL refuse a key that is not 32 bytes',
    (key) => {
      expect(() => new AesGcmWebhookCipher(key)).toThrow(RangeError);
    },
  );
});

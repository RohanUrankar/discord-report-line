import { isAllowedWebhookUrl } from '../domain/webhookUrl.js';
import type { MirrorWebhookStore } from '../ports/mirrorWebhookStore.js';
import type { WebhookCipher } from '../ports/webhookCipher.js';

const LAST_CHARS_SHOWN = 4;

export type SaveMirrorWebhookResult =
  | {
      ok: true;
      /** The last characters of the URL, enough for an admin to recognise it. Never the whole URL. */ endsIn: string;
    }
  | { ok: false; reason: 'not_allowed' };

export interface SaveMirrorWebhookInput {
  guildId: string;
  /** The secret. Validated, encrypted and then forgotten: it is never returned, logged or put in an error. */
  url: string;
  allowedPrefix: string;
}

/**
 * Validates a Slack webhook URL and stores it encrypted for one server (DESIGN §9, security-secrets: SSRF).
 * Only a URL under the allowed prefix is accepted, so the worker can never be pointed at an internal host.
 * The same check runs again just before every send.
 */
export async function saveMirrorWebhook(
  input: SaveMirrorWebhookInput,
  deps: { cipher: WebhookCipher; store: MirrorWebhookStore },
): Promise<SaveMirrorWebhookResult> {
  if (!isAllowedWebhookUrl(input.url, input.allowedPrefix)) {
    return { ok: false, reason: 'not_allowed' };
  }
  await deps.store.save(input.guildId, deps.cipher.encrypt(input.url, input.guildId));
  return { ok: true, endsIn: input.url.slice(-LAST_CHARS_SHOWN) };
}

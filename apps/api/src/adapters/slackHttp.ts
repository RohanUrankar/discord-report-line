import type { CallResult } from '../ports/outbound.js';
import type { SlackMirror } from '../ports/slack.js';
import { performCall } from './httpCall.js';
import { isAllowedWebhookUrl } from '../domain/webhookUrl.js';

export interface SlackHttpOptions {
  timeoutMs: number;
  /** The only URL prefix that may be called (config SLACK_WEBHOOK_URL_PREFIX). */
  allowedUrlPrefix: string;
  fetchFn?: typeof fetch;
}

/** Posts `{ "text": ... }` to an Incoming Webhook. The URL is a secret: it appears in no result and no log. */
export class SlackHttpClient implements SlackMirror {
  public constructor(private readonly options: SlackHttpOptions) {}

  public send(webhookUrl: string, text: string): Promise<CallResult> {
    if (!isAllowedWebhookUrl(webhookUrl, this.options.allowedUrlPrefix)) {
      // Re-checked at send time: a stored value could have been edited in the database (SSRF defence).
      return Promise.resolve({ ok: false, failure: {} });
    }
    return performCall({
      url: webhookUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      timeoutMs: this.options.timeoutMs,
      fetchFn: this.options.fetchFn ?? fetch,
    });
  }
}

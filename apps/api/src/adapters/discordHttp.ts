import type { MessageBody } from '../domain/discordProtocol.js';
import type { DiscordClient } from '../ports/discord.js';
import type { CallResult } from '../ports/outbound.js';
import { performCall } from './httpCall.js';

const USER_AGENT = 'DiscordBot (the-report-line, 0.1.0)'; // Discord asks for this shape on every API call

export interface DiscordHttpOptions {
  apiBaseUrl: string;
  /** A real secret. Only ever put in the Authorization header of the channel post. */
  botToken: string;
  timeoutMs: number;
  /** Injected so tests never touch the network. */
  fetchFn?: typeof fetch;
}

/**
 * Discord REST over fetch (DESIGN §4). The interaction token is part of the edit's URL, so a result from this
 * class never includes the URL: it is a status or a kind, nothing else.
 */
export class DiscordHttpClient implements DiscordClient {
  private readonly baseUrl: string;

  public constructor(private readonly options: DiscordHttpOptions) {
    this.baseUrl = options.apiBaseUrl.replace(/\/+$/, '');
  }

  public editOriginal(
    appId: string,
    interactionToken: string,
    body: MessageBody,
  ): Promise<CallResult> {
    // PATCH, not POST: a retried PATCH rewrites the same message, a retried POST would add a second one.
    const path = `/webhooks/${encodeURIComponent(appId)}/${encodeURIComponent(interactionToken)}/messages/@original`;
    return this.call('PATCH', path, body, false);
  }

  public postChannelMessage(channelId: string, body: MessageBody): Promise<CallResult> {
    return this.call('POST', `/channels/${encodeURIComponent(channelId)}/messages`, body, true);
  }

  private call(
    method: 'POST' | 'PATCH',
    path: string,
    body: MessageBody,
    withBotToken: boolean,
  ): Promise<CallResult> {
    return performCall({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        ...(withBotToken ? { authorization: `Bot ${this.options.botToken}` } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: this.options.timeoutMs,
      fetchFn: this.options.fetchFn ?? fetch,
    });
  }
}

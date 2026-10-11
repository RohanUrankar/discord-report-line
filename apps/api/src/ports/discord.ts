import type { MessageBody } from '../domain/discordProtocol.js';
import type { CallResult } from './outbound.js';

/**
 * The two Discord REST calls the worker makes (DESIGN §8.1, narrowed to what Step 3 uses: interface
 * segregation). The follow-up POST is deliberately absent: a retried POST would duplicate the message.
 */
export interface DiscordClient {
  /** `PATCH /webhooks/{appId}/{token}/messages/@original`. Idempotent, so a retry cannot double the reply. */
  editOriginal(appId: string, interactionToken: string, body: MessageBody): Promise<CallResult>;
  /** Bot-token channel post: the fallback once the interaction token is dead (DESIGN §11.3 step 4). */
  postChannelMessage(channelId: string, body: MessageBody): Promise<CallResult>;
}

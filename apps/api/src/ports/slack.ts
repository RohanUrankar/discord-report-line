import type { CallResult } from './outbound.js';

/** The team notification. The URL is a secret; the text is already escaped (domain/mirrorMessage.ts). */
export interface SlackMirror {
  send(webhookUrl: string, text: string): Promise<CallResult>;
}

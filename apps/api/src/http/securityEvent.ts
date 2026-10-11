import type { Request } from 'express';

import type { Logger } from '../ports/logger.js';
import { contextOf } from './middleware.js';

/**
 * Who did what, and did it work (observability skill). Ids and short reason codes only: no email, no password,
 * no cookie, no free text. `src` is the client address, kept for the audit trail.
 */
export function securityEvent(
  req: Request,
  logger: Logger,
  level: 'info' | 'warn',
  event: string,
  fields: { result: 'success' | 'failed'; reason?: string; adminId?: string; guildId?: string },
): void {
  contextOf(req, logger).log[level]({ logType: 'security', event, src: req.ip, ...fields }, event);
}

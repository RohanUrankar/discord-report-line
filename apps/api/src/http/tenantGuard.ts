import { ErrorCode, Snowflake } from '@report-line/shared';
import type { Request, RequestHandler } from 'express';

import type { DashboardService } from '../app/dashboard.js';
import type { Logger } from '../ports/logger.js';
import { adminOf } from './authRoutes.js';
import { sendApiError } from './middleware.js';
import { securityEvent } from './securityEvent.js';

const guildIds = new WeakMap<Request, string>();

/** The guild `tenantGuard` verified for this request. Throws if the guard was not mounted first. */
export function guildOf(req: Request): string {
  const guildId = guildIds.get(req);
  if (guildId === undefined) {
    throw new Error('guildOf() used on a route without tenantGuard.');
  }
  return guildId;
}

/**
 * TenantGuard (DESIGN §2.3, §10.4, SR-4): the guild in the path must be one the signed-in admin manages.
 * A guild that is not theirs, a guild that does not exist and an id that is not even an id all get the SAME
 * 404, so the response never confirms that another tenant's guild exists. The refusal is logged as a
 * security event with ids only. If the lookup itself fails the error handler answers 500: the guard fails
 * closed, never open. Mount after `requireSession`, on a path with a `:guildId` parameter.
 */
export function tenantGuard(dashboard: DashboardService, logger: Logger): RequestHandler {
  return async (req, res, next) => {
    const { adminId } = adminOf(req);
    const parsed = Snowflake.safeParse(req.params.guildId);
    if (parsed.success && (await dashboard.managesGuild(adminId, parsed.data))) {
      guildIds.set(req, parsed.data);
      next();
      return;
    }
    securityEvent(req, logger, 'warn', 'tenant.access_denied', {
      result: 'failed',
      reason: parsed.success ? 'not_managed' : 'malformed_guild_id',
      adminId,
      // Only an id-shaped value is logged: the path is attacker-controlled text.
      ...(parsed.success ? { guildId: parsed.data } : {}),
    });
    sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
  };
}

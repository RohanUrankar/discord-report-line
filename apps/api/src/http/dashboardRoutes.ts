import { ErrorCode, ListInteractionsQuery, Snowflake } from '@report-line/shared';
import { Router } from 'express';

import type { DashboardService } from '../app/dashboard.js';
import { adminOf, requireSession, type AuthHttpDeps } from './authRoutes.js';
import { sendApiError } from './middleware.js';
import { guildOf, tenantGuard } from './tenantGuard.js';

export interface DashboardHttpDeps extends AuthHttpDeps {
  dashboard: DashboardService;
}

/** Everything under one managed guild. Mounted behind `requireSession` and `tenantGuard`. */
function guildRouter({ dashboard }: DashboardHttpDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/interactions', async (req, res) => {
    const query = ListInteractionsQuery.safeParse(req.query);
    if (!query.success) {
      sendApiError(req, res, 400, ErrorCode.VALIDATION_FAILED);
      return;
    }
    const result = await dashboard.listInteractions(adminOf(req).adminId, guildOf(req), query.data);
    if (result.kind === 'invalid_cursor') {
      sendApiError(req, res, 400, ErrorCode.VALIDATION_FAILED);
      return;
    }
    res.status(200).json(result.page);
  });

  router.get('/interactions/:id', async (req, res) => {
    // An id that is not an id cannot exist: the same 404 as one that is not in this guild.
    const id = Snowflake.safeParse(req.params.id);
    const detail = id.success
      ? await dashboard.getInteraction(adminOf(req).adminId, guildOf(req), id.data)
      : undefined;
    if (detail === undefined) {
      sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
      return;
    }
    res.status(200).json(detail);
  });

  return router;
}

/** `GET /api/guilds` and `/api/guilds/:guildId/...`: the tenant-scoped read API (DESIGN §10.4). */
export function dashboardRouter(deps: DashboardHttpDeps): Router {
  const { dashboard, logger } = deps;
  const router = Router();
  router.use('/guilds', requireSession(deps));

  router.get('/guilds', async (req, res) => {
    res.status(200).json(await dashboard.listGuilds(adminOf(req).adminId));
  });
  router.use('/guilds/:guildId', tenantGuard(dashboard, logger), guildRouter(deps));
  return router;
}

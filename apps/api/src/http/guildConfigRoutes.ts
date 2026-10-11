import {
  ConnectGuildRequest,
  ErrorCode,
  UpdateGuildSettingsRequest,
  UpdateRuleRequest,
} from '@report-line/shared';
import { Router, type Request, type RequestHandler, type Response } from 'express';

import type { GuildConfigService } from '../app/guildConfig.js';
import { fieldPaths, publicFieldPaths } from '../domain/fieldPaths.js';
import type { Logger } from '../ports/logger.js';
import { adminOf } from './authRoutes.js';
import { sendApiError } from './middleware.js';
import { securityEvent } from './securityEvent.js';
import { guildOf } from './tenantGuard.js';

export interface GuildConfigHttpDeps {
  guildConfig: GuildConfigService;
  logger: Logger;
}

/** Every field name this API defines for a change. Any other path is an invented key and is not echoed. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'guildId',
  'postChannelId',
  'mirrorWebhookUrl',
  'enabled',
  'command',
  'config',
  'config.version',
  'config.ephemeral',
  'config.replyMessage',
  'config.mirror',
  'config.tag',
]);

/** 400 with the field paths and nothing the admin typed, plus a security event (a refused config change). */
function rejectInvalid(
  req: Request,
  res: Response,
  logger: Logger,
  event: string,
  fields: readonly string[],
  guildId?: string,
): void {
  const shown = publicFieldPaths(fields, KNOWN_FIELDS);
  securityEvent(req, logger, 'warn', event, {
    result: 'failed',
    reason: 'validation_failed',
    adminId: adminOf(req).adminId,
    ...(guildId === undefined ? {} : { guildId }),
    fields: shown,
  });
  sendApiError(req, res, 400, ErrorCode.VALIDATION_FAILED, shown);
}

/**
 * `POST /api/guilds` (connect a server). Not behind `tenantGuard`: the admin does not manage the server yet,
 * that is what this call changes. "No such server" and "someone else manages it" get the same 404.
 */
export function connectGuild({ guildConfig, logger }: GuildConfigHttpDeps): RequestHandler {
  return async (req, res) => {
    const { adminId } = adminOf(req);
    const body = ConnectGuildRequest.safeParse(req.body);
    if (!body.success) {
      rejectInvalid(req, res, logger, 'guild.connect.rejected', fieldPaths(body.error.issues));
      return;
    }
    const guild = await guildConfig.connect(adminId, body.data.guildId);
    if (guild === undefined) {
      securityEvent(req, logger, 'warn', 'guild.connect.denied', {
        result: 'failed',
        reason: 'not_available',
        adminId,
        guildId: body.data.guildId,
      });
      sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
      return;
    }
    securityEvent(req, logger, 'info', 'guild.connected', {
      result: 'success',
      adminId,
      guildId: guild.id,
    });
    res.status(200).json(guild);
  };
}

/** `/settings` and `/rules` of one managed server. Mounted behind `requireSession`, CSRF and `tenantGuard`. */
export function guildConfigRouter({ guildConfig, logger }: GuildConfigHttpDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/settings', async (req, res) => {
    const settings = await guildConfig.getSettings(adminOf(req).adminId, guildOf(req));
    if (settings === undefined) {
      sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
      return;
    }
    res.status(200).json(settings);
  });

  router.put('/settings', async (req, res) => {
    const { adminId } = adminOf(req);
    const guildId = guildOf(req);
    const body = UpdateGuildSettingsRequest.safeParse(req.body);
    if (!body.success) {
      rejectInvalid(
        req,
        res,
        logger,
        'config.settings.rejected',
        fieldPaths(body.error.issues),
        guildId,
      );
      return;
    }
    const result = await guildConfig.updateSettings(adminId, guildId, body.data);
    switch (result.kind) {
      case 'invalid':
        rejectInvalid(req, res, logger, 'config.settings.rejected', result.fields, guildId);
        return;
      case 'not_found':
        sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
        return;
      case 'ok':
        securityEvent(req, logger, 'info', 'config.settings.updated', {
          result: 'success',
          adminId,
          guildId,
          changed: result.changed,
        });
        res.status(200).json(result.settings);
        return;
    }
  });

  router.get('/rules', async (req, res) => {
    res.status(200).json(await guildConfig.listRules(adminOf(req).adminId, guildOf(req)));
  });

  router.put('/rules/:command', async (req, res) => {
    const { adminId } = adminOf(req);
    const guildId = guildOf(req);
    const body = UpdateRuleRequest.safeParse(req.body);
    if (!body.success) {
      rejectInvalid(
        req,
        res,
        logger,
        'config.rule.rejected',
        fieldPaths(body.error.issues),
        guildId,
      );
      return;
    }
    const result = await guildConfig.saveRule(adminId, guildId, req.params.command, body.data);
    switch (result.kind) {
      case 'invalid':
        rejectInvalid(req, res, logger, 'config.rule.rejected', result.fields, guildId);
        return;
      case 'not_found':
        sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
        return;
      case 'ok':
        securityEvent(req, logger, 'info', 'config.rule.updated', {
          result: 'success',
          adminId,
          guildId,
          command: result.rule.command,
        });
        res.status(200).json(result.rule);
        return;
    }
  });

  return router;
}

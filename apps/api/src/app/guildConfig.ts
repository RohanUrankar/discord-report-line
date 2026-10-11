import {
  DEFAULT_RULES,
  ReportRuleConfig,
  StatusRuleConfig,
  type CommandName,
  type GuildSettings,
  type GuildSummary,
  type RuleList,
  type RuleView,
  type UpdateGuildSettingsRequest,
  type UpdateRuleRequest,
} from '@report-line/shared';

import { isCommandName, ROOT_FIELD, validateRule } from '../domain/rules.js';
import { isAllowedWebhookUrl } from '../domain/webhookUrl.js';
import type { GuildConfigStore, SettingsPatch, StoredRule } from '../ports/guildConfig.js';
import type { WebhookCipher } from '../ports/webhookCipher.js';
import { toGuildSummary } from './dashboardView.js';

/** The commands with a rule editor, in the order the dashboard lists them. */
const COMMANDS = ['status', 'report'] as const satisfies readonly CommandName[];

const COMMAND_FIELD = 'command';
const CONFIG_FIELD = 'config';

export type UpdateSettingsResult =
  | { kind: 'ok'; settings: GuildSettings; changed: ('postChannelId' | 'mirrorWebhookUrl')[] }
  | { kind: 'invalid'; fields: string[] }
  | { kind: 'not_found' };

export type SaveRuleResult =
  { kind: 'ok'; rule: RuleView } | { kind: 'invalid'; fields: string[] } | { kind: 'not_found' };

export interface GuildConfigOptions {
  /** `SLACK_WEBHOOK_URL_PREFIX`: the only place a mirror webhook may point (security-secrets: SSRF). */
  allowedWebhookPrefix: string;
}

/**
 * The dashboard's write use cases: connect a server, set where its reports go, edit its command rules
 * (DESIGN §2.3, rev 6). Every call names the admin and the guild; the store refuses to touch a server that
 * admin does not manage. The webhook URL is validated, encrypted and forgotten here: it is never returned,
 * logged or put in a result.
 */
export class GuildConfigService {
  public constructor(
    private readonly store: GuildConfigStore,
    private readonly cipher: WebhookCipher,
    private readonly options: GuildConfigOptions,
  ) {}

  /** First claim wins (DESIGN rev 6). `undefined` covers "no such server" and "someone else manages it". */
  public async connect(adminId: string, guildId: string): Promise<GuildSummary | undefined> {
    const guild = await this.store.claimGuild(adminId, guildId);
    return guild === undefined ? undefined : toGuildSummary(guild);
  }

  public async getSettings(adminId: string, guildId: string): Promise<GuildSettings | undefined> {
    return this.store.readSettings(adminId, guildId);
  }

  public async updateSettings(
    adminId: string,
    guildId: string,
    request: UpdateGuildSettingsRequest,
  ): Promise<UpdateSettingsResult> {
    const patch: SettingsPatch = {};
    const changed: ('postChannelId' | 'mirrorWebhookUrl')[] = [];
    if (request.postChannelId !== undefined) {
      patch.postChannelId = request.postChannelId === '' ? null : request.postChannelId;
      changed.push('postChannelId');
    }
    if (request.mirrorWebhookUrl !== undefined) {
      const url = request.mirrorWebhookUrl;
      if (
        url !== null &&
        url !== '' &&
        !isAllowedWebhookUrl(url, this.options.allowedWebhookPrefix)
      ) {
        return { kind: 'invalid', fields: ['mirrorWebhookUrl'] };
      }
      patch.mirrorWebhookEnc =
        url === null || url === '' ? null : this.cipher.encrypt(url, guildId);
      changed.push('mirrorWebhookUrl');
    }
    const settings = await this.store.updateSettings(adminId, guildId, patch);
    return settings === undefined ? { kind: 'not_found' } : { kind: 'ok', settings, changed };
  }

  public async listRules(adminId: string, guildId: string): Promise<RuleList> {
    const stored = await this.store.listRules(adminId, guildId);
    return { items: COMMANDS.map((command) => toRuleView(command, stored)) };
  }

  /**
   * Validates against the command's schema (DESIGN §8.3) and saves the PARSED config, so what is stored is
   * exactly what the schema accepts (trimmed text, no extra keys). A problem is reported by field path only.
   */
  public async saveRule(
    adminId: string,
    guildId: string,
    command: string,
    request: UpdateRuleRequest,
  ): Promise<SaveRuleResult> {
    if (!isCommandName(command)) {
      return { kind: 'invalid', fields: [COMMAND_FIELD] };
    }
    const checked = validateRule(command, request.config);
    if (!checked.ok) {
      return { kind: 'invalid', fields: checked.fields.map(underConfig) };
    }
    const saved = await this.store.saveRule(
      adminId,
      guildId,
      command,
      checked.rule,
      request.enabled,
    );
    if (!saved) {
      return { kind: 'not_found' };
    }
    return {
      kind: 'ok',
      rule: toRuleView(command, [{ command, config: checked.rule, enabled: request.enabled }]),
    };
  }
}

function underConfig(field: string): string {
  return field === ROOT_FIELD ? CONFIG_FIELD : `${CONFIG_FIELD}.${field}`;
}

/**
 * The stored rule, or the built-in default when there is none or the stored JSON no longer validates (the
 * runtime fallback of DESIGN §8.3; the editor must never fail to open because one row is corrupt).
 */
function toRuleView(command: CommandName, stored: readonly StoredRule[]): RuleView {
  const row = stored.find((rule) => rule.command === command);
  const enabled = row?.enabled ?? true;
  switch (command) {
    case 'status': {
      const parsed = StatusRuleConfig.safeParse(row?.config);
      return {
        command,
        enabled,
        customised: parsed.success,
        config: parsed.success ? parsed.data : DEFAULT_RULES.status,
      };
    }
    case 'report': {
      const parsed = ReportRuleConfig.safeParse(row?.config);
      return {
        command,
        enabled,
        customised: parsed.success,
        config: parsed.success ? parsed.data : DEFAULT_RULES.report,
      };
    }
  }
}

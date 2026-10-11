import { z } from 'zod';

// Per-command rule configs stored in COMMAND_RULE.config (DESIGN §8.3). `.strict()` rejects unknown keys
// so the dashboard cannot smuggle extra fields into stored config. `enabled` is its own column, not config.

export const StatusRuleConfig = z
  .object({
    version: z.literal(1),
    ephemeral: z.boolean(),
  })
  .strict();
export type StatusRuleConfig = z.infer<typeof StatusRuleConfig>;

export const ReportRuleConfig = z
  .object({
    version: z.literal(1),
    ephemeral: z.boolean(), // fixed at defer time: the only flag a type 5 response accepts (§4)
    replyMessage: z.string().trim().min(1).max(300), // plain text, no placeholders in v1
    mirror: z.boolean(), // F-05 Slack notification
    tag: z.boolean(), // F-12; no effect unless LLM_ENABLED
  })
  .strict();
export type ReportRuleConfig = z.infer<typeof ReportRuleConfig>;

export const RULE_SCHEMAS = { status: StatusRuleConfig, report: ReportRuleConfig } as const;
export type CommandName = keyof typeof RULE_SCHEMAS; // 'status' | 'report'

/** Used when a command has no COMMAND_RULE row, or its stored config fails validation at runtime. */
export const DEFAULT_RULES = {
  status: { version: 1, ephemeral: true },
  report: {
    version: 1,
    ephemeral: true,
    replyMessage: 'Report logged. The team has been notified.',
    mirror: true,
    tag: false,
  },
} as const satisfies { status: StatusRuleConfig; report: ReportRuleConfig };

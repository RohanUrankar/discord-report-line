import {
  DEFAULT_RULES,
  RULE_SCHEMAS,
  type CommandName,
  type ReportRuleConfig,
  type StatusRuleConfig,
} from '@report-line/shared';
import type { z } from 'zod';

import type { Action } from './types.js';

export type RuleValidation<C> = { ok: true; rule: C } | { ok: false; fields: string[] };

/** Inputs to rule evaluation that are not part of the config JSON (DESIGN §8.3). */
export interface RuleContext {
  /** COMMAND_RULE.enabled; true when the command has no row. */
  enabled: boolean;
}

/** Field path reported when the problem is the config as a whole (not an object, wrong shape). */
export const ROOT_FIELD = '(root)';
const UNKNOWN_COMMAND_FIELD = 'command';

export function isCommandName(command: string): command is CommandName {
  // Object.hasOwn, not `in`: a command named "__proto__" or "toString" must not match.
  return Object.hasOwn(RULE_SCHEMAS, command);
}

/**
 * Validates a stored or submitted rule config against its command's schema (DESIGN §8.3).
 * Never throws. Unknown command → `{ ok: false, fields: ['command'] }`. Reports field PATHS, never values,
 * so the response and logs never echo what the admin typed.
 */
export function validateRule(
  command: string,
  json: unknown,
): RuleValidation<StatusRuleConfig | ReportRuleConfig> {
  if (!isCommandName(command)) {
    return { ok: false, fields: [UNKNOWN_COMMAND_FIELD] };
  }
  return safeValidate(RULE_SCHEMAS[command], json);
}

/**
 * Decides what to do for a command (DESIGN §8.3). Order: unknown command → disabled → command action.
 * `rule` is the stored config JSON, or null when there is no row. An invalid stored rule falls back to
 * DEFAULT_RULES so a corrupt row can never break the next command. The caller logs that case by calling
 * `validateRule` itself; this function stays pure.
 */
export function evaluate(command: string, ctx: RuleContext, rule: unknown): Action {
  if (!isCommandName(command)) {
    return { type: 'unknown_command' };
  }
  if (!ctx.enabled) {
    return { type: 'disabled' };
  }
  switch (command) {
    case 'status': {
      const config = resolve(RULE_SCHEMAS.status, rule, DEFAULT_RULES.status);
      return { type: 'status', ephemeral: config.ephemeral };
    }
    case 'report': {
      const config = resolve(RULE_SCHEMAS.report, rule, DEFAULT_RULES.report);
      return {
        type: 'report',
        ephemeral: config.ephemeral,
        replyMessage: config.replyMessage,
        mirror: config.mirror,
        tag: config.tag,
      };
    }
  }
}

function resolve<S extends z.ZodType>(
  schema: S,
  rule: unknown,
  fallback: z.output<S>,
): z.output<S> {
  if (rule === null || rule === undefined) {
    return fallback;
  }
  const result = safeValidate(schema, rule);
  return result.ok ? result.rule : fallback;
}

function safeValidate<S extends z.ZodType>(schema: S, json: unknown): RuleValidation<z.output<S>> {
  try {
    const result = schema.safeParse(json);
    if (result.success) {
      return { ok: true, rule: result.data };
    }
    return { ok: false, fields: fieldPaths(result.error.issues) };
  } catch {
    // safeParse only throws on hostile input (e.g. a Proxy or a throwing getter); treat it as invalid.
    return { ok: false, fields: [ROOT_FIELD] };
  }
}

function fieldPaths(issues: readonly z.core.$ZodIssue[]): string[] {
  const paths = issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => [...issue.path.map(String), key].join('.'));
    }
    return [issue.path.length === 0 ? ROOT_FIELD : issue.path.map(String).join('.')];
  });
  return [...new Set(paths)];
}

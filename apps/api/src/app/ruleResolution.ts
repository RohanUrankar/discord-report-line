import { withDeadline } from './deadline.js';
import { errorLogFields } from '../domain/errorFields.js';
import { evaluate, isCommandName, loggableFields, validateRule } from '../domain/rules.js';
import type { Action } from '../domain/types.js';
import type { Logger } from '../ports/logger.js';
import type { RuleReader } from '../ports/rules.js';

/**
 * The one place a command's stored rule is turned into an Action (DESIGN §8.3): /status, /report with text,
 * the modal submit and the report buttons all call this. Nothing else reads rule JSON.
 *
 * An invalid stored row never breaks a command: a warning with the field PATHS (never values) is logged and
 * `evaluate` falls back to DEFAULT_RULES. A rule that cannot be read at all returns 'unavailable' so the
 * caller says so, instead of guessing whether the command is switched off.
 */
export async function resolveAction(
  rules: RuleReader,
  guildId: string,
  command: string,
  timeoutMs: number,
  log: Logger,
): Promise<Action | 'unavailable'> {
  if (!isCommandName(command)) {
    return evaluate(command, { enabled: true }, null);
  }
  try {
    const stored = await withDeadline(rules.read(guildId, command), timeoutMs);
    if (stored === undefined) {
      return evaluate(command, { enabled: true }, null);
    }
    const checked = validateRule(command, stored.config);
    if (!checked.ok) {
      log.warn({ command, fields: loggableFields(checked.fields) }, 'rule.invalid_stored');
    }
    return evaluate(command, { enabled: stored.enabled }, stored.config);
  } catch (error) {
    log.error(errorLogFields(error), 'rule.read_failed');
    return 'unavailable';
  }
}

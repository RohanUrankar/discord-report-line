import type { CommandName, ReportRuleConfig, StatusRuleConfig } from '@report-line/shared';

export type FieldKind = 'toggle' | 'text';

export interface FieldSpec {
  readonly kind: FieldKind;
  readonly label: string;
  readonly hint: string;
}

interface ConfigByCommand {
  readonly status: StatusRuleConfig;
  readonly report: ReportRuleConfig;
}

type EditableKey<C extends CommandName> = Exclude<keyof ConfigByCommand[C], 'version'>;

/**
 * The editor is driven by this table, and the table is checked against the shared rule schemas by the
 * compiler: add a key to a schema in packages/shared and this file stops compiling until the new setting
 * has a label; remove one and the stale entry is an error too. `version` is not editable.
 */
export const RULE_FIELDS = {
  status: {
    ephemeral: {
      kind: 'toggle',
      label: 'Only the person who ran it sees the reply',
      hint: 'Turn this off to show the reply to everyone in the channel.',
    },
  },
  report: {
    ephemeral: {
      kind: 'toggle',
      label: 'Only the person who ran it sees the reply',
      hint: 'Turn this off to show the reply to everyone in the channel.',
    },
    replyMessage: {
      kind: 'text',
      label: 'Reply message',
      hint: 'Shown to the person who sent the report. Plain text, 1 to 300 characters.',
    },
    mirror: {
      kind: 'toggle',
      label: 'Send a Slack notification',
      hint: 'Posts each report to your Slack channel.',
    },
    tag: {
      kind: 'toggle',
      label: 'Add an AI tag',
      hint: 'Has no effect unless AI tagging is switched on for the bot.',
    },
  },
} as const satisfies { readonly [C in CommandName]: Readonly<Record<EditableKey<C>, FieldSpec>> };

export const COMMAND_TITLES: Readonly<Record<CommandName, { title: string; description: string }>> =
  {
    status: {
      title: '/status',
      description: 'Shows how the bot is doing. It answers straight away.',
    },
    report: {
      title: '/report',
      description: 'Lets members report a problem. The bot answers, then notifies your team.',
    },
  };

/** Wording for a setting the server rejected, by field name. */
export const FIELD_SERVER_TEXT: Readonly<Record<string, string>> = {
  replyMessage: 'Write a reply between 1 and 300 characters.',
};

export const DEFAULT_FIELD_SERVER_TEXT = 'Check this setting.';

// The slash commands this app registers with Discord (DESIGN §5). One list, used by scripts/register-commands.ts.
// Limits verified on docs.discord.com (interactions/application-commands): name 1-32 lowercase, description 1-100,
// string option min_length 0-6000, max_length 1-6000, option type STRING = 3.

export const APPLICATION_COMMAND_TYPE = { CHAT_INPUT: 1 } as const;
export const COMMAND_OPTION_TYPE = { STRING: 3 } as const;
/** Where a command may be used. Guild only: the bot has no DM behaviour (DESIGN §8.3 router note). */
export const INTERACTION_CONTEXT = { GUILD: 0 } as const;

/** The `text` option of /report (DESIGN §5.2). The server re-checks these: they are a client-side hint. */
export const REPORT_TEXT_OPTION = 'text';
export const REPORT_TEXT_MIN_LENGTH = 1;
export const REPORT_TEXT_MAX_LENGTH = 1000;

export interface CommandOptionDefinition {
  type: typeof COMMAND_OPTION_TYPE.STRING;
  name: string;
  description: string;
  required: boolean;
  min_length: number;
  max_length: number;
}

export interface CommandDefinition {
  name: string;
  description: string;
  type: typeof APPLICATION_COMMAND_TYPE.CHAT_INPUT;
  contexts: (typeof INTERACTION_CONTEXT.GUILD)[];
  options?: CommandOptionDefinition[];
}

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  {
    name: 'status',
    description: 'See how the report line is doing right now',
    type: APPLICATION_COMMAND_TYPE.CHAT_INPUT,
    contexts: [INTERACTION_CONTEXT.GUILD],
  },
  {
    name: 'report',
    description: 'Report a problem to the team',
    type: APPLICATION_COMMAND_TYPE.CHAT_INPUT,
    contexts: [INTERACTION_CONTEXT.GUILD],
    options: [
      {
        type: COMMAND_OPTION_TYPE.STRING,
        name: REPORT_TEXT_OPTION,
        description: "What's happening?",
        required: false,
        min_length: REPORT_TEXT_MIN_LENGTH,
        max_length: REPORT_TEXT_MAX_LENGTH,
      },
    ],
  },
];

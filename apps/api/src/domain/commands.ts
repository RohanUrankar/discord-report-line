// The slash commands this app registers with Discord (DESIGN §5). One list, used by scripts/register-commands.ts.
// Limits verified on docs.discord.com (interactions/application-commands): name 1-32 lowercase, description 1-100.

export const APPLICATION_COMMAND_TYPE = { CHAT_INPUT: 1 } as const;
/** Where a command may be used. Guild only: the bot has no DM behaviour (DESIGN §8.3 router note). */
export const INTERACTION_CONTEXT = { GUILD: 0 } as const;

export interface CommandDefinition {
  name: string;
  description: string;
  type: typeof APPLICATION_COMMAND_TYPE.CHAT_INPUT;
  contexts: (typeof INTERACTION_CONTEXT.GUILD)[];
}

/** Step 1 registers /status only; /report joins in Step 3 together with its handler. */
export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  {
    name: 'status',
    description: 'See how the report line is doing right now',
    type: APPLICATION_COMMAND_TYPE.CHAT_INPUT,
    contexts: [INTERACTION_CONTEXT.GUILD],
  },
];

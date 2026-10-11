// Registers the slash commands in ONE guild (instant, unlike global commands). Run by hand:
//   npm run register-commands
// Needs DISCORD_APP_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN in the environment (see .env.example).
// PUT replaces the guild's whole command set, so running it twice is safe.
import {
  CommandRegistrationError,
  registerGuildCommands,
} from '../apps/api/src/adapters/discordCommands.js';
import { ConfigError, loadRegisterConfig } from '../apps/api/src/config.js';
import { COMMAND_DEFINITIONS } from '../apps/api/src/domain/commands.js';

async function main(): Promise<void> {
  const config = loadRegisterConfig();
  await registerGuildCommands({
    apiBaseUrl: config.DISCORD_API_BASE_URL,
    appId: config.DISCORD_APP_ID,
    guildId: config.DISCORD_GUILD_ID,
    botToken: config.DISCORD_BOT_TOKEN,
    commands: COMMAND_DEFINITIONS,
    timeoutMs: config.DISCORD_TIMEOUT_MS,
  });
  const names = COMMAND_DEFINITIONS.map((command) => `/${command.name}`).join(', ');
  process.stdout.write(`Registered ${names} in the test server.\n`);
}

main().catch((error: unknown) => {
  // Both error types carry safe, human-readable messages (names of variables, or a status). Nothing else is printed.
  const known = error instanceof ConfigError || error instanceof CommandRegistrationError;
  process.stderr.write(`${known ? error.message : 'Command registration failed unexpectedly.'}\n`);
  process.exit(1);
});

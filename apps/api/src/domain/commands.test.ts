import { describe, expect, it } from 'vitest';

import { COMMAND_DEFINITIONS } from './commands.js';

// https://docs.discord.com/developers/interactions/application-commands (name 1-32, description 1-100)
describe('registered command definitions', () => {
  it('registers /status only in Step 1', () => {
    expect(COMMAND_DEFINITIONS.map((command) => command.name)).toEqual(['status']);
  });

  it.each(COMMAND_DEFINITIONS)('keeps $name within Discord naming limits', (command) => {
    expect(command.name).toMatch(/^[a-z0-9_-]{1,32}$/);
    expect(command.description.length).toBeGreaterThanOrEqual(1);
    expect(command.description.length).toBeLessThanOrEqual(100);
  });

  it('limits every command to guild use', () => {
    for (const command of COMMAND_DEFINITIONS) {
      expect(command.contexts).toEqual([0]);
    }
  });
});

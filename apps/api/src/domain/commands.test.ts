import { describe, expect, it } from 'vitest';

import { COMMAND_DEFINITIONS } from './commands.js';

// https://docs.discord.com/developers/interactions/application-commands
// (name 1-32, description 1-100, STRING option type 3, min_length 0-6000, max_length 1-6000)
describe('registered command definitions', () => {
  it('registers /status and /report', () => {
    expect(COMMAND_DEFINITIONS.map((command) => command.name)).toEqual(['status', 'report']);
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

  it('gives /report one optional STRING option "text" of 1 to 1000 characters (DESIGN §5.2)', () => {
    const report = COMMAND_DEFINITIONS.find((command) => command.name === 'report');

    expect(report?.options).toEqual([
      {
        type: 3,
        name: 'text',
        description: "What's happening?",
        required: false,
        min_length: 1,
        max_length: 1000,
      },
    ]);
  });

  it('keeps every option name and description within Discord limits', () => {
    for (const option of COMMAND_DEFINITIONS.flatMap((command) => command.options ?? [])) {
      expect(option.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
  });
});

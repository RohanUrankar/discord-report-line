import { describe, expect, it } from 'vitest';

import { ConfigError, loadRegisterConfig, loadServerConfig } from './config.js';

const PUBLIC_KEY = 'ab'.repeat(32);

describe('loadServerConfig', () => {
  it('applies defaults when only the required public key is set', () => {
    const config = loadServerConfig({ DISCORD_PUBLIC_KEY: PUBLIC_KEY });
    expect(config).toEqual({
      PORT: 3000,
      LOG_LEVEL: 'info',
      DISCORD_PUBLIC_KEY: PUBLIC_KEY,
      REPLAY_WINDOW_MS: 300_000,
      STATUS_TIMEOUT_MS: 1500,
    });
  });

  it('fails fast naming the missing variable', () => {
    expect(() => loadServerConfig({})).toThrow(ConfigError);
    expect(() => loadServerConfig({})).toThrow(/DISCORD_PUBLIC_KEY/);
  });

  it('treats an empty value as unset', () => {
    expect(() => loadServerConfig({ DISCORD_PUBLIC_KEY: '' })).toThrow(/DISCORD_PUBLIC_KEY/);
    expect(loadServerConfig({ DISCORD_PUBLIC_KEY: PUBLIC_KEY, PORT: '' }).PORT).toBe(3000);
  });

  it('never puts the offending value in the error message', () => {
    const badValue = 'replace-me-not-hex-SECRET-VALUE';
    try {
      loadServerConfig({ DISCORD_PUBLIC_KEY: badValue });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(badValue);
      expect((error as ConfigError).variables).toEqual(['DISCORD_PUBLIC_KEY']);
    }
  });

  it.each([['0'], ['65536'], ['abc'], ['-1']])('rejects PORT=%s', (port) => {
    expect(() => loadServerConfig({ DISCORD_PUBLIC_KEY: PUBLIC_KEY, PORT: port })).toThrow(/PORT/);
  });

  it('rejects a public key of the wrong length', () => {
    expect(() => loadServerConfig({ DISCORD_PUBLIC_KEY: 'ab'.repeat(31) })).toThrow(
      /DISCORD_PUBLIC_KEY/,
    );
  });
});

describe('loadRegisterConfig', () => {
  const valid = {
    DISCORD_APP_ID: '123456789012345678',
    DISCORD_GUILD_ID: '223456789012345678',
    DISCORD_BOT_TOKEN: 'placeholder-token',
  };

  it('requires app id, guild id and bot token, and defaults the API base URL', () => {
    expect(loadRegisterConfig(valid).DISCORD_API_BASE_URL).toBe('https://discord.com/api/v10');
    expect(() => loadRegisterConfig({})).toThrow(
      /DISCORD_APP_ID, DISCORD_GUILD_ID, DISCORD_BOT_TOKEN/,
    );
  });

  it('rejects a non-snowflake guild id', () => {
    expect(() => loadRegisterConfig({ ...valid, DISCORD_GUILD_ID: 'my-server' })).toThrow(
      /DISCORD_GUILD_ID/,
    );
  });
});

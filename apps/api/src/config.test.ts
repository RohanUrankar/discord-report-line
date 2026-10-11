import { describe, expect, it } from 'vitest';

import { ConfigError, loadMigrateConfig, loadRegisterConfig, loadServerConfig } from './config.js';

const PUBLIC_KEY = 'ab'.repeat(32);
const DATABASE_URL = 'postgresql://user:password@localhost:5432/example';
const REQUIRED = { DISCORD_PUBLIC_KEY: PUBLIC_KEY, DATABASE_URL };

describe('loadServerConfig', () => {
  it('applies defaults when only the required variables are set', () => {
    const config = loadServerConfig(REQUIRED);
    expect(config).toEqual({
      PORT: 3000,
      LOG_LEVEL: 'info',
      DISCORD_PUBLIC_KEY: PUBLIC_KEY,
      REPLAY_WINDOW_MS: 300_000,
      STATUS_TIMEOUT_MS: 1500,
      RECORD_TIMEOUT_MS: 1200,
      DATABASE_URL,
      DB_POOL_MAX: 5,
      DB_CONNECTION_TIMEOUT_MS: 1000,
      DB_STATEMENT_TIMEOUT_MS: 1500,
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 5000,
    });
  });

  it('fails fast naming every missing variable', () => {
    expect(() => loadServerConfig({})).toThrow(ConfigError);
    expect(() => loadServerConfig({})).toThrow(/DISCORD_PUBLIC_KEY.*DATABASE_URL/);
  });

  it('requires a postgres connection URL and never echoes it', () => {
    const bad = 'mysql://user:hunter2@host/db';
    const attempt = () => loadServerConfig({ ...REQUIRED, DATABASE_URL: bad });
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).not.toThrow(/hunter2/);
  });

  it('rejects record and status timeouts that together exceed the 3 s window', () => {
    const attempt = () =>
      loadServerConfig({ ...REQUIRED, RECORD_TIMEOUT_MS: '2000', STATUS_TIMEOUT_MS: '1500' });
    expect(attempt).toThrow(/RECORD_TIMEOUT_MS/);
  });

  it('treats an empty value as unset', () => {
    expect(() => loadServerConfig({ ...REQUIRED, DISCORD_PUBLIC_KEY: '' })).toThrow(
      /DISCORD_PUBLIC_KEY/,
    );
    expect(loadServerConfig({ ...REQUIRED, PORT: '' }).PORT).toBe(3000);
  });

  it('never puts the offending value in the error message', () => {
    const badValue = 'replace-me-not-hex-SECRET-VALUE';
    try {
      loadServerConfig({ ...REQUIRED, DISCORD_PUBLIC_KEY: badValue });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(badValue);
      expect((error as ConfigError).variables).toEqual(['DISCORD_PUBLIC_KEY']);
    }
  });

  it.each([['0'], ['65536'], ['abc'], ['-1']])('rejects PORT=%s', (port) => {
    expect(() => loadServerConfig({ ...REQUIRED, PORT: port })).toThrow(/PORT/);
  });

  it('rejects a public key of the wrong length', () => {
    expect(() => loadServerConfig({ ...REQUIRED, DISCORD_PUBLIC_KEY: 'ab'.repeat(31) })).toThrow(
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

describe('loadMigrateConfig', () => {
  it('needs only the database URL', () => {
    expect(loadMigrateConfig({ DATABASE_URL })).toEqual({ DATABASE_URL });
    expect(() => loadMigrateConfig({})).toThrow(/DATABASE_URL/);
  });
});

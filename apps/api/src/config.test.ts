import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_WEB_DIST_DIR,
  loadMigrateConfig,
  loadRegisterConfig,
  loadSeedAdminConfig,
  loadServerConfig,
  loadWebhookScriptConfig,
  loadWorkerConfig,
  loadWorkerMode,
} from './config.js';

const PUBLIC_KEY = 'ab'.repeat(32);
const DATABASE_URL = 'postgresql://user:password@localhost:5432/example';
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const WORKER_REQUIRED = {
  DATABASE_URL,
  DISCORD_APP_ID: '123456789012345678',
  DISCORD_BOT_TOKEN: 'placeholder-bot-token',
  WEBHOOK_ENC_KEY: ENC_KEY,
};
const SESSION_SECRET = 's'.repeat(32);
const REQUIRED = { DISCORD_PUBLIC_KEY: PUBLIC_KEY, SESSION_SECRET, ...WORKER_REQUIRED };

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
      SESSION_SECRET,
      SESSION_TTL_MS: 28_800_000,
      SESSION_COOKIE_SECURE: true,
      TRUST_PROXY_HOPS: 0,
      WEB_DIST_DIR: DEFAULT_WEB_DIST_DIR,
      DISCORD_APP_ID: '123456789012345678',
      DISCORD_BOT_TOKEN: 'placeholder-bot-token',
      WEBHOOK_ENC_KEY: ENC_KEY,
      DISCORD_API_BASE_URL: 'https://discord.com/api/v10',
      DISCORD_TIMEOUT_MS: 5000,
      SLACK_TIMEOUT_MS: 5000,
      SLACK_WEBHOOK_URL_PREFIX: 'https://hooks.slack.com/services/',
      WORKER_MODE: 'inline',
      CLAIM_BATCH: 5,
      POLL_INTERVAL_MS: 1000,
      LEASE_MS: 60_000,
      MAX_ATTEMPTS: 8,
      BACKOFF_BASE_MS: 500,
      BACKOFF_MAX_MS: 60_000,
      WORKER_DB_POOL_MAX: 3,
      WORKER_DB_CONNECTION_TIMEOUT_MS: 5000,
      WORKER_DB_STATEMENT_TIMEOUT_MS: 10_000,
      WORKER_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 15_000,
    });
  });

  it('fails fast naming every missing variable', () => {
    expect(() => loadServerConfig({})).toThrow(ConfigError);
    expect(() => loadServerConfig({})).toThrow(/DISCORD_PUBLIC_KEY.*DATABASE_URL/);
  });

  it.each(['DISCORD_APP_ID', 'DISCORD_BOT_TOKEN', 'WEBHOOK_ENC_KEY', 'SESSION_SECRET'])(
    'refuses to start without %s',
    (name) => {
      expect(() => loadServerConfig({ ...REQUIRED, [name]: undefined })).toThrow(name);
    },
  );

  it.each([
    ['not base64', '!!!!'],
    ['16 bytes', Buffer.alloc(16, 1).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64')],
  ])('rejects a WEBHOOK_ENC_KEY that is %s, without echoing it', (_label, key) => {
    const attempt = () => loadServerConfig({ ...REQUIRED, WEBHOOK_ENC_KEY: key });
    expect(attempt).toThrow(/WEBHOOK_ENC_KEY/);
    expect(attempt).not.toThrow(key);
  });

  it('rejects a lease that does not outlast three call timeouts', () => {
    expect(() =>
      loadServerConfig({ ...REQUIRED, LEASE_MS: '10000', DISCORD_TIMEOUT_MS: '5000' }),
    ).toThrow(/LEASE_MS/);
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

describe('WEB_DIST_DIR', () => {
  it('WHEN unset or empty THE SYSTEM SHALL default to the Angular build output of apps/web', () => {
    expect(path.posix.normalize(DEFAULT_WEB_DIST_DIR.split(path.sep).join('/'))).toMatch(
      /apps\/web\/dist\/web\/browser$/,
    );
    expect(loadServerConfig({ ...REQUIRED, WEB_DIST_DIR: '' }).WEB_DIST_DIR).toBe(
      DEFAULT_WEB_DIST_DIR,
    );
  });

  it('WHEN set THE SYSTEM SHALL use it', () => {
    expect(loadServerConfig({ ...REQUIRED, WEB_DIST_DIR: '/srv/web' }).WEB_DIST_DIR).toBe(
      '/srv/web',
    );
  });
});

describe('dashboard session settings', () => {
  it('WHEN SESSION_COOKIE_SECURE is unset or empty THE SYSTEM SHALL default to a Secure cookie', () => {
    expect(loadServerConfig(REQUIRED).SESSION_COOKIE_SECURE).toBe(true);
    expect(loadServerConfig({ ...REQUIRED, SESSION_COOKIE_SECURE: '' }).SESSION_COOKIE_SECURE).toBe(
      true,
    );
  });

  it('WHEN SESSION_COOKIE_SECURE is exactly "false" THE SYSTEM SHALL turn Secure off, and nothing else does', () => {
    expect(
      loadServerConfig({ ...REQUIRED, SESSION_COOKIE_SECURE: 'false' }).SESSION_COOKIE_SECURE,
    ).toBe(false);
    for (const value of ['0', 'no', 'FALSE', 'off']) {
      expect(() => loadServerConfig({ ...REQUIRED, SESSION_COOKIE_SECURE: value })).toThrow(
        /SESSION_COOKIE_SECURE/,
      );
    }
  });

  it('WHEN SESSION_SECRET is shorter than 32 characters THE SYSTEM SHALL refuse to start, naming only the variable', () => {
    const attempt = () => loadServerConfig({ ...REQUIRED, SESSION_SECRET: 'too-short-secret' });
    expect(attempt).toThrow(/SESSION_SECRET/);
    expect(attempt).not.toThrow(/too-short-secret/);
  });

  it.each(['-1', '11', 'many'])(
    'WHEN TRUST_PROXY_HOPS is %s THE SYSTEM SHALL refuse it',
    (value) => {
      expect(() => loadServerConfig({ ...REQUIRED, TRUST_PROXY_HOPS: value })).toThrow(
        /TRUST_PROXY_HOPS/,
      );
    },
  );
});

describe('loadSeedAdminConfig', () => {
  const SEED = {
    DATABASE_URL,
    ADMIN_EMAIL: 'admin@example.test',
    ADMIN_PASSWORD: 'twelve-chars-ok',
  };

  it('WHEN the credentials are present THE SYSTEM SHALL accept them', () => {
    expect(loadSeedAdminConfig(SEED).ADMIN_EMAIL).toBe('admin@example.test');
  });

  it('WHEN the password is shorter than 12 characters THE SYSTEM SHALL refuse, without echoing it', () => {
    const attempt = () => loadSeedAdminConfig({ ...SEED, ADMIN_PASSWORD: 'short' });
    expect(attempt).toThrow(/ADMIN_PASSWORD/);
    expect(attempt).not.toThrow(/short/);
  });

  it.each(['ADMIN_EMAIL', 'ADMIN_PASSWORD'])(
    'WHEN %s is missing THE SYSTEM SHALL refuse',
    (name) => {
      expect(() => loadSeedAdminConfig({ ...SEED, [name]: undefined })).toThrow(name);
    },
  );
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

describe('loadWorkerConfig', () => {
  it('needs no public key, because the standalone worker serves no HTTP', () => {
    const config = loadWorkerConfig(WORKER_REQUIRED);
    expect(config.WORKER_MODE).toBe('inline');
    expect(config.CLAIM_BATCH).toBe(5);
  });

  it('fails fast naming the missing worker variables', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL })).toThrow(
      /DISCORD_APP_ID, DISCORD_BOT_TOKEN, WEBHOOK_ENC_KEY/,
    );
  });
});

describe('loadWorkerMode', () => {
  it('defaults to inline and accepts standalone', () => {
    expect(loadWorkerMode({})).toBe('inline');
    expect(loadWorkerMode({ WORKER_MODE: 'standalone' })).toBe('standalone');
  });

  it('rejects anything else', () => {
    expect(() => loadWorkerMode({ WORKER_MODE: 'both' })).toThrow(/WORKER_MODE/);
  });
});

describe('loadWebhookScriptConfig', () => {
  it('needs the database, the key and defaults to the Slack prefix', () => {
    const config = loadWebhookScriptConfig({ DATABASE_URL, WEBHOOK_ENC_KEY: ENC_KEY });
    expect(config.SLACK_WEBHOOK_URL_PREFIX).toBe('https://hooks.slack.com/services/');
    expect(() => loadWebhookScriptConfig({ DATABASE_URL })).toThrow(/WEBHOOK_ENC_KEY/);
  });
});

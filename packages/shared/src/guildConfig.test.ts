import { describe, expect, it } from 'vitest';

import {
  ApiErrorBody,
  ConnectGuildRequest,
  GuildSettings,
  RuleView,
  UpdateGuildSettingsRequest,
  UpdateRuleRequest,
  WEBHOOK_URL_MAX_LENGTH,
} from './index.js';

const ID = '900000000000000555';

describe('GuildSettings', () => {
  it('WHEN a response has only the safe fields THE SYSTEM SHALL accept it', () => {
    expect(GuildSettings.safeParse({ postChannelId: ID, mirrorConfigured: true }).success).toBe(
      true,
    );
    expect(GuildSettings.safeParse({ postChannelId: null, mirrorConfigured: false }).success).toBe(
      true,
    );
  });

  it.each([
    ['the webhook', { postChannelId: null, mirrorConfigured: true, mirrorWebhookUrl: 'x' }],
    ['the last characters', { postChannelId: null, mirrorConfigured: true, last4: 'abcd' }],
  ])('WHEN a response carries %s THE SYSTEM SHALL reject it', (_name, body) => {
    expect(GuildSettings.safeParse(body).success).toBe(false);
  });
});

describe('UpdateGuildSettingsRequest', () => {
  it.each([
    ['a channel', { postChannelId: ID }],
    ['a webhook', { mirrorWebhookUrl: 'https://hooks.slack.com/services/T/B/x' }],
    ['both cleared with null', { postChannelId: null, mirrorWebhookUrl: null }],
    ['both cleared with empty text', { postChannelId: '', mirrorWebhookUrl: '' }],
  ])('WHEN the body has %s THE SYSTEM SHALL accept it', (_name, body) => {
    expect(UpdateGuildSettingsRequest.safeParse(body).success).toBe(true);
  });

  it('WHEN the webhook has blanks around it THE SYSTEM SHALL trim them, and blanks alone mean clear', () => {
    expect(UpdateGuildSettingsRequest.parse({ mirrorWebhookUrl: '  https://a.test/  ' })).toEqual({
      mirrorWebhookUrl: 'https://a.test/',
    });
    expect(UpdateGuildSettingsRequest.parse({ mirrorWebhookUrl: '   ' })).toEqual({
      mirrorWebhookUrl: '',
    });
  });

  it.each([
    ['no setting at all', {}],
    ['an unknown key', { postChannelId: ID, extra: 1 }],
    ['a channel that is not an id', { postChannelId: '12' }],
    ['a webhook of the wrong type', { mirrorWebhookUrl: 5 }],
    ['a webhook over the limit', { mirrorWebhookUrl: 'a'.repeat(WEBHOOK_URL_MAX_LENGTH + 1) }],
    ['a body that is not an object', 'text'],
    ['no body', undefined],
  ])('WHEN the body has %s THE SYSTEM SHALL reject it', (_name, body) => {
    expect(UpdateGuildSettingsRequest.safeParse(body).success).toBe(false);
  });

  it('WHEN the webhook is exactly at the limit THE SYSTEM SHALL accept it', () => {
    const body = { mirrorWebhookUrl: 'a'.repeat(WEBHOOK_URL_MAX_LENGTH) };
    expect(UpdateGuildSettingsRequest.safeParse(body).success).toBe(true);
  });
});

describe('ConnectGuildRequest', () => {
  it('WHEN the body is one server id THE SYSTEM SHALL accept it', () => {
    expect(ConnectGuildRequest.safeParse({ guildId: ID }).success).toBe(true);
  });

  it.each([
    ['a number', { guildId: 12345 }],
    ['text that is not an id', { guildId: 'my server' }],
    ['an extra key', { guildId: ID, adminId: 'x' }],
    ['nothing', {}],
  ])('WHEN the body has %s THE SYSTEM SHALL reject it', (_name, body) => {
    expect(ConnectGuildRequest.safeParse(body).success).toBe(false);
  });
});

describe('rule schemas', () => {
  it('WHEN a rule view matches its command THE SYSTEM SHALL accept it', () => {
    const view = {
      command: 'status',
      enabled: true,
      customised: false,
      config: { version: 1, ephemeral: true },
    };
    expect(RuleView.safeParse(view).success).toBe(true);
  });

  it('WHEN a rule view carries another command’s config THE SYSTEM SHALL reject it', () => {
    const view = {
      command: 'report',
      enabled: true,
      customised: false,
      config: { version: 1, ephemeral: true },
    };
    expect(RuleView.safeParse(view).success).toBe(false);
  });

  it('WHEN an update has enabled and a config of any shape THE SYSTEM SHALL pass the config on unchecked', () => {
    expect(UpdateRuleRequest.safeParse({ enabled: false, config: { anything: 1 } }).success).toBe(
      true,
    );
  });

  it.each([
    ['no enabled flag', { config: {} }],
    ['no config', { enabled: true }],
    ['an extra key', { enabled: true, config: {}, command: 'report' }],
  ])('WHEN an update has %s THE SYSTEM SHALL reject it', (_name, body) => {
    expect(UpdateRuleRequest.safeParse(body).success).toBe(false);
  });
});

describe('ApiErrorBody details', () => {
  const error = { code: 'VALIDATION_FAILED', message: 'x', requestId: 'r' };

  it('WHEN a validation error lists field paths THE SYSTEM SHALL accept them', () => {
    const details = { fields: ['config.replyMessage'] };
    expect(ApiErrorBody.safeParse({ error: { ...error, details } }).success).toBe(true);
  });

  it.each([
    ['no fields', { fields: [] }],
    ['another key', { fields: ['a'], value: 'secret' }],
  ])('WHEN the details have %s THE SYSTEM SHALL reject them', (_name, details) => {
    expect(ApiErrorBody.safeParse({ error: { ...error, details } }).success).toBe(false);
  });
});

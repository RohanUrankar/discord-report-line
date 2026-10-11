import { describe, expect, it } from 'vitest';

import { classify, parseInteraction, type RawInteraction } from './router.js';

const INTERACTION_ID = '1300000000000000001';
const GUILD_ID = '1100000000000000001';
const CHANNEL_ID = '1200000000000000001';
const USER_ID = '1000000000000000001';
const MESSAGE_ID = '1400000000000000001';

const ORIGIN = {
  actor: { userId: USER_ID },
  tenant: { guildId: GUILD_ID, channelId: CHANNEL_ID },
};

function guildInteraction(type: number, data: unknown, extra: object = {}): RawInteraction {
  const parsed = parseInteraction({
    id: INTERACTION_ID,
    type,
    application_id: '1',
    token: 'interaction-token-placeholder',
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: { user: { id: USER_ID } },
    data,
    ...extra,
  });
  if (!parsed) {
    throw new Error('fixture did not parse');
  }
  return parsed;
}

function dmInteraction(type: number, data: unknown): RawInteraction {
  const parsed = parseInteraction({
    id: INTERACTION_ID,
    type,
    token: 'interaction-token-placeholder',
    channel_id: CHANNEL_ID,
    user: { id: USER_ID },
    data,
  });
  if (!parsed) {
    throw new Error('fixture did not parse');
  }
  return parsed;
}

describe('parseInteraction', () => {
  it('accepts a minimal PING with no member, data or guild', () => {
    expect(
      parseInteraction({ id: INTERACTION_ID, type: 1, application_id: '1', version: 1 }),
    ).toEqual({ id: INTERACTION_ID, type: 1, application_id: '1' });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'hello'],
    ['missing type', { id: INTERACTION_ID }],
    ['missing id', { type: 1 }],
    ['non-numeric id', { id: 'abc', type: 1 }],
    ['fractional type', { id: INTERACTION_ID, type: 1.5 }],
    ['a guild id that is not a snowflake', { id: INTERACTION_ID, type: 2, guild_id: '1; drop' }],
  ])('rejects %s', (_case, json) => {
    expect(parseInteraction(json)).toBeUndefined();
  });

  it('strips fields it does not read', () => {
    const parsed = parseInteraction({ id: INTERACTION_ID, type: 1, locale: 'en-GB' });
    expect(parsed).toEqual({ id: INTERACTION_ID, type: 1 });
  });
});

describe('classify', () => {
  it('routes a PING to ping without reading member, data or guild', () => {
    const ping = parseInteraction({ id: INTERACTION_ID, type: 1 });
    expect(ping && classify(ping)).toEqual({ kind: 'ping' });
  });

  it('routes /report with a text option to a command with flattened options', () => {
    const interaction = guildInteraction(2, {
      name: 'report',
      options: [{ name: 'text', type: 3, value: 'printer is on fire' }],
    });
    expect(classify(interaction)).toEqual({
      kind: 'command',
      name: 'report',
      options: { text: 'printer is on fire' },
      ...ORIGIN,
    });
  });

  it('routes /report without options to a command with empty options', () => {
    expect(classify(guildInteraction(2, { name: 'report' }))).toEqual({
      kind: 'command',
      name: 'report',
      options: {},
      ...ORIGIN,
    });
  });

  it('keeps an option named __proto__ as plain data, not a prototype', () => {
    const decision = classify(
      guildInteraction(2, { name: 'report', options: [{ name: '__proto__', value: 'x' }] }),
    );
    expect(decision.kind).toBe('command');
    expect(Object.getPrototypeOf(decision.kind === 'command' ? decision.options : {})).toBe(
      Object.prototype,
    );
  });

  it('reads the channel from the channel object when channel_id is absent', () => {
    const interaction = guildInteraction(
      2,
      { name: 'status' },
      {
        channel_id: undefined,
        channel: { id: CHANNEL_ID },
      },
    );
    expect(classify(interaction)).toMatchObject({ kind: 'command', tenant: ORIGIN.tenant });
  });

  it('routes a button click to a component with its message', () => {
    const interaction = guildInteraction(
      3,
      { custom_id: `rpt:ack:${INTERACTION_ID}`, component_type: 2 },
      { message: { id: MESSAGE_ID } },
    );
    expect(classify(interaction)).toEqual({
      kind: 'component',
      customId: `rpt:ack:${INTERACTION_ID}`,
      message: { messageId: MESSAGE_ID },
      ...ORIGIN,
    });
  });

  it('treats a component interaction without a message as unsupported', () => {
    expect(classify(guildInteraction(3, { custom_id: 'rpt:ack:1' }))).toEqual({
      kind: 'unsupported',
    });
  });

  it('reads modal fields from the Label layout (type 18 wrapping text input 4)', () => {
    const interaction = guildInteraction(5, {
      custom_id: 'report_modal',
      components: [
        { type: 18, id: 1, component: { type: 4, id: 2, custom_id: 'report_text', value: 'hi' } },
      ],
    });
    expect(classify(interaction)).toEqual({
      kind: 'modalSubmit',
      customId: 'report_modal',
      fields: { report_text: 'hi' },
      ...ORIGIN,
    });
  });

  it('reads modal fields from the legacy Action Row layout (type 1 wrapping text inputs)', () => {
    const interaction = guildInteraction(5, {
      custom_id: 'report_modal',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'report_text', value: 'hi' }] }],
    });
    expect(classify(interaction)).toMatchObject({ fields: { report_text: 'hi' } });
  });

  it('ignores non-text-input components in a modal submission', () => {
    const interaction = guildInteraction(5, {
      custom_id: 'report_modal',
      components: [
        { type: 18, component: { type: 3, custom_id: 'severity', values: ['high'] } },
        { type: 10, content: 'just text' },
        { type: 18, component: { type: 4, custom_id: 'report_text', value: 'kept' } },
      ],
    });
    expect(classify(interaction)).toMatchObject({ fields: { report_text: 'kept' } });
  });

  it('treats a malformed modal submission as unsupported', () => {
    expect(classify(guildInteraction(5, { components: [] }))).toEqual({ kind: 'unsupported' });
  });

  it('WHEN an interaction comes from a DM THE SYSTEM SHALL classify it as unsupported', () => {
    expect(classify(dmInteraction(2, { name: 'report' }))).toEqual({ kind: 'unsupported' });
    expect(classify(dmInteraction(5, { custom_id: 'report_modal', components: [] }))).toEqual({
      kind: 'unsupported',
    });
  });

  it('treats a guild interaction without a member as unsupported', () => {
    expect(classify(guildInteraction(2, { name: 'report' }, { member: undefined }))).toEqual({
      kind: 'unsupported',
    });
  });

  it.each([
    ['autocomplete (4)', 4],
    ['an unknown type (99)', 99],
  ])('treats %s as unsupported', (_case, type) => {
    expect(classify(guildInteraction(type, { name: 'report' }))).toEqual({ kind: 'unsupported' });
  });

  it('treats a command with no data as unsupported', () => {
    expect(classify(guildInteraction(2, undefined))).toEqual({ kind: 'unsupported' });
  });
});

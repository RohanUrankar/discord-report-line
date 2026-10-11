export const GUILD_ID = '900000000000000001';
export const CHANNEL_ID = '900000000000000002';
export const USER_ID = '900000000000000003';
export const INTERACTION_ID = '900000000000000004';
/** A recognisable fake: tests assert it never shows up in logs. */
export const FAKE_INTERACTION_TOKEN = 'fake-interaction-token-do-not-log';

export const pingPayload = {
  id: INTERACTION_ID,
  application_id: '900000000000000005',
  type: 1,
  token: FAKE_INTERACTION_TOKEN,
  version: 1,
};

export function commandPayload(name: string, options?: unknown[]): Record<string, unknown> {
  return {
    id: INTERACTION_ID,
    application_id: '900000000000000005',
    type: 2,
    token: FAKE_INTERACTION_TOKEN,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: { user: { id: USER_ID } },
    data: { id: '900000000000000006', name, type: 1, ...(options ? { options } : {}) },
  };
}

/** `/report text:...` as Discord sends it: one STRING option (type 3). */
export function reportPayload(text: string, id: string = INTERACTION_ID): Record<string, unknown> {
  return { ...commandPayload('report', [{ name: 'text', type: 3, value: text }]), id };
}

/** A command run in a DM: no guild_id and no member, only `user`. */
export function dmCommandPayload(name: string): Record<string, unknown> {
  return {
    id: INTERACTION_ID,
    application_id: '900000000000000005',
    type: 2,
    token: FAKE_INTERACTION_TOKEN,
    channel_id: CHANNEL_ID,
    user: { id: USER_ID },
    data: { id: '900000000000000006', name, type: 1 },
  };
}

export function componentPayload(customId: string): Record<string, unknown> {
  return {
    id: INTERACTION_ID,
    application_id: '900000000000000005',
    type: 3,
    token: FAKE_INTERACTION_TOKEN,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: { user: { id: USER_ID } },
    message: { id: '900000000000000007' },
    data: { custom_id: customId, component_type: 2 },
  };
}

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

export const MODAL_ID = 'report_modal';
export const MODAL_TEXT_ID = 'report_text';

/** A /report modal submit in the current Label layout (type 18 wrapping one text input). */
export function modalSubmitPayload(
  text: string | undefined,
  id: string = INTERACTION_ID,
  customId: string = MODAL_ID,
): Record<string, unknown> {
  return {
    ...componentBase(5, id),
    data: {
      custom_id: customId,
      components: [
        {
          type: 18,
          id: 1,
          component:
            text === undefined
              ? { type: 4, id: 2, custom_id: 'other_field', value: 'x' }
              : { type: 4, id: 2, custom_id: MODAL_TEXT_ID, value: text },
        },
      ],
    },
  };
}

/** The same submit in the deprecated Action Row layout (type 1 wrapping a list of text inputs). */
export function legacyModalSubmitPayload(
  text: string,
  id: string = INTERACTION_ID,
): Record<string, unknown> {
  return {
    ...componentBase(5, id),
    data: {
      custom_id: MODAL_ID,
      components: [{ type: 1, components: [{ type: 4, custom_id: MODAL_TEXT_ID, value: text }] }],
    },
  };
}

function componentBase(type: number, id: string): Record<string, unknown> {
  return {
    id,
    application_id: '900000000000000005',
    type,
    token: FAKE_INTERACTION_TOKEN,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: { user: { id: USER_ID } },
  };
}

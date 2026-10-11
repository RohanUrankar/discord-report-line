import type { EnqueuedJob, RecordInput } from '../../src/ports/ledger.js';
import {
  CHANNEL_ID,
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  USER_ID,
} from './payloads.js';

/** A `/status`-shaped record: answered inline, no job, mirror skipped. Override any part per test. */
export function answeredInput(overrides: Partial<RecordInput['interaction']> = {}): RecordInput {
  return {
    interaction: {
      id: INTERACTION_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      userId: USER_ID,
      type: 2,
      commandName: 'status',
      customId: null,
      options: {},
      status: 'answered',
      ...overrides,
    },
    action: { type: 'status', summary: null, mirrorStatus: 'skipped' },
  };
}

/** A `/report`-shaped record: deferred, mirror pending, with the outbox job and its token. */
export function reportInput(overrides: Partial<RecordInput['interaction']> = {}): RecordInput {
  const base = answeredInput({ commandName: 'report', status: 'deferred', ...overrides });
  return {
    interaction: base.interaction,
    action: { type: 'report', summary: null, mirrorStatus: 'pending' },
    job: jobFixture(),
  };
}

export function jobFixture(overrides: Partial<EnqueuedJob> = {}): EnqueuedJob {
  return {
    kind: 'report',
    interactionToken: FAKE_INTERACTION_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 15 * 60_000),
    payload: {
      text: 'the printer is jammed',
      userId: USER_ID,
      channelId: CHANNEL_ID,
      ephemeral: true,
      replyMessage: 'Report logged. The team has been notified.',
      mirror: true,
      tag: false,
    },
    ...overrides,
  };
}

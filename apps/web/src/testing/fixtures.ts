import {
  AttemptView,
  GuildSettings,
  InteractionDetail,
  InteractionLogItem,
  InteractionLogPage,
  RuleView,
  SessionInfo,
} from '@report-line/shared';

// Fixtures are built through the shared zod schemas, so a fixture that drifts from the contract fails
// the test run instead of quietly testing a shape the server never sends. No real ids, tokens or URLs.

export const GUILD_A = '111111111111111111';
export const GUILD_B = '222222222222222222';
export const USER_ID = '333333333333333333';
export const CSRF = 'csrf-token-for-tests';
export const ADMIN_ID = '7f3a2b10-0c1d-4e5f-8a9b-1c2d3e4f5a6b';

export function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return SessionInfo.parse({
    admin: { id: ADMIN_ID, email: 'admin@example.test' },
    csrfToken: CSRF,
    ...overrides,
  });
}

/** Ids are snowflakes: later ids sort higher, so `n` doubles as an ordering knob. */
export function snowflake(n: number): string {
  return String(444444444444000000n + BigInt(n));
}

export function logItem(
  n: number,
  overrides: Partial<InteractionLogItem> = {},
  createdAtMs: number = Date.parse('2026-10-12T10:00:00.000Z') + n * 1000,
): InteractionLogItem {
  return InteractionLogItem.parse({
    id: snowflake(n),
    createdAt: new Date(createdAtMs).toISOString(),
    command: 'report',
    userId: USER_ID,
    interactionStatus: 'followed_up',
    action: { type: 'report', mirrorStatus: 'sent', llmTag: null },
    job: { status: 'done', attempts: 1, lastError: null },
    ...overrides,
  });
}

export function logPage(
  items: InteractionLogItem[],
  nextCursor: string | null = null,
): InteractionLogPage {
  return InteractionLogPage.parse({ items, nextCursor });
}

export function attempt(overrides: Partial<AttemptView> = {}): AttemptView {
  return AttemptView.parse({
    attemptNo: 1,
    target: 'mirror',
    outcome: 'success',
    httpStatus: 200,
    error: null,
    startedAt: '2026-10-12T10:00:01.000Z',
    finishedAt: '2026-10-12T10:00:02.000Z',
    ...overrides,
  });
}

export function detail(
  item: InteractionLogItem,
  attemptHistory: AttemptView[] = [],
): InteractionDetail {
  return InteractionDetail.parse({ ...item, attemptHistory });
}

export function settings(overrides: Partial<GuildSettings> = {}): GuildSettings {
  return GuildSettings.parse({ postChannelId: null, mirrorConfigured: false, ...overrides });
}

export function reportRule(overrides: Record<string, unknown> = {}): RuleView {
  const { config, ...rest } = overrides;
  return RuleView.parse({
    command: 'report',
    enabled: true,
    customised: false,
    config: {
      version: 1,
      ephemeral: true,
      replyMessage: 'Report logged. The team has been notified.',
      mirror: true,
      tag: false,
      ...(config as Record<string, unknown> | undefined),
    },
    ...rest,
  });
}

export function statusRule(overrides: Record<string, unknown> = {}): RuleView {
  return RuleView.parse({
    command: 'status',
    enabled: true,
    customised: false,
    config: { version: 1, ephemeral: true },
    ...overrides,
  });
}

/** An error body exactly as the API writes it. */
export function errorBody(
  code: string,
  extra: { fields?: string[]; requestId?: string } = {},
): object {
  return {
    error: {
      code,
      message: 'server wording that the UI must not depend on',
      requestId: extra.requestId ?? 'req-1234',
      ...(extra.fields === undefined ? {} : { details: { fields: extra.fields } }),
    },
  };
}

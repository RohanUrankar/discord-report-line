import type pg from 'pg';
import { afterEach, beforeEach } from 'vitest';

import { AesGcmWebhookCipher } from '../../src/adapters/aesGcmWebhookCipher.js';
import { DiscordHttpClient } from '../../src/adapters/discordHttp.js';
import { PgJobRepository } from '../../src/adapters/pg/pgJobRepository.js';
import { PgLedger } from '../../src/adapters/pg/pgLedger.js';
import { PgWorkerHeartbeat } from '../../src/adapters/pg/pgWorkerHeartbeat.js';
import { GeminiHttpTagger } from '../../src/adapters/geminiHttp.js';
import { SlackHttpClient } from '../../src/adapters/slackHttp.js';
import { ReportJobRunner } from '../../src/app/reportJobRunner.js';
import { Worker } from '../../src/app/worker.js';
import type { ReportJobPayload } from '../../src/domain/reportJob.js';
import { createLogger } from '../../src/http/middleware.js';
import type { Clock } from '../../src/ports/clock.js';
import type { RecordInput } from '../../src/ports/ledger.js';
import { truncateAll } from './db.js';
import { GEMINI_TEST_KEY } from './gemini.js';
import { LogSink } from './logging.js';
import {
  CHANNEL_ID,
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  USER_ID,
} from './payloads.js';
import { StubServer } from './stubServer.js';

export const APP_ID = '900000000000000005';
export const BOT_TOKEN = 'fake-bot-token-do-not-log';
/** Looks like a Slack webhook path; the last part is the secret a test asserts never leaks. */
export const WEBHOOK_SECRET = 'fake-webhook-secret-do-not-log';
export const TEST_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
export const NOTIFICATION_CHANNEL_ID = '900000000000000099';

/** Time that moves only when a test says so, so backoff and token expiry never depend on the wall clock. */
export class ManualClock implements Clock {
  public constructor(private ms: number = Date.now()) {}

  public set(ms: number): void {
    this.ms = ms;
  }

  public nowMs(): number {
    return this.ms;
  }

  public advance(ms: number): void {
    this.ms += ms;
  }
}

export interface HarnessOptions {
  maxAttempts?: number;
  leaseMs?: number;
  batch?: number;
  slackTimeoutMs?: number;
  discordTimeoutMs?: number;
  /** A fixed value in [0, 1]: 1 makes the full-jitter backoff its maximum, so delays are predictable. */
  random?: number;
  /** The pool the first worker uses, when a test wants to watch or isolate it. */
  pool?: pg.Pool;
  /** Turns LLM tagging on, pointed at the `gemini` stub. Absent: no tagger exists, as with LLM_ENABLED=false. */
  llm?: { timeoutMs?: number };
}

export interface Harness {
  slack: StubServer;
  /** Stands in for Gemini. It sees no traffic unless the harness was started with `llm`. */
  gemini: StubServer;
  discord: StubServer;
  clock: ManualClock;
  logs: LogSink;
  worker: Worker;
  cipher: AesGcmWebhookCipher;
  /** Ticks until a tick claims nothing; returns how many jobs were claimed in total. */
  drain(): Promise<number>;
  /** Builds another worker over the same stubs and clock, with its own pool or the given one. */
  addWorker(pool: pg.Pool): Worker;
  stop(): Promise<void>;
}

const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 1000;
const MAX_DRAIN_TICKS = 200;

export async function startHarness(pool: pg.Pool, options: HarnessOptions = {}): Promise<Harness> {
  const slack = await StubServer.start();
  const discord = await StubServer.start();
  const gemini = await StubServer.start();
  const clock = new ManualClock();
  const logs = new LogSink();
  const logger = createLogger('debug', logs);
  const cipher = new AesGcmWebhookCipher(TEST_ENC_KEY);

  const buildWorker = (forPool: pg.Pool): Worker => {
    const jobs = new PgJobRepository(forPool);
    const runner = new ReportJobRunner(
      {
        jobs,
        discord: new DiscordHttpClient({
          apiBaseUrl: `${discord.baseUrl}/api/v10`,
          botToken: BOT_TOKEN,
          timeoutMs: options.discordTimeoutMs ?? 1000,
        }),
        slack: new SlackHttpClient({
          timeoutMs: options.slackTimeoutMs ?? 1000,
          allowedUrlPrefix: `${slack.baseUrl}/services/`,
        }),
        tagger:
          options.llm === undefined
            ? undefined
            : new GeminiHttpTagger({
                apiBaseUrl: `${gemini.baseUrl}/v1beta`,
                apiKey: GEMINI_TEST_KEY,
                model: 'gemini-test-model',
                timeoutMs: options.llm.timeoutMs ?? 1000,
              }),
        cipher,
        clock,
        random: () => options.random ?? 1,
      },
      {
        appId: APP_ID,
        maxAttempts: options.maxAttempts ?? 8,
        backoffBaseMs: BACKOFF_BASE_MS,
        backoffMaxMs: BACKOFF_MAX_MS,
      },
    );
    return new Worker(
      { jobs, runner, heartbeat: new PgWorkerHeartbeat(forPool), clock, logger },
      {
        batch: options.batch ?? 5,
        pollIntervalMs: 20,
        leaseMs: options.leaseMs ?? 60_000,
      },
    );
  };

  const worker = buildWorker(options.pool ?? pool);
  return {
    slack,
    discord,
    gemini,
    clock,
    logs,
    worker,
    cipher,
    async drain() {
      let total = 0;
      for (let tick = 0; tick < MAX_DRAIN_TICKS; tick += 1) {
        const claimed = await worker.tick();
        if (claimed === 0) {
          return total;
        }
        total += claimed;
      }
      throw new Error('The worker kept claiming jobs; the test would loop forever.');
    },
    addWorker: buildWorker,
    async stop() {
      await worker.stop();
      await Promise.all([slack.close(), discord.close(), gemini.close()]);
    },
  };
}

export interface SeedOptions {
  /** Interaction id. Distinct per job in a test that seeds several. */
  id?: string;
  text?: string;
  ephemeral?: boolean;
  mirror?: boolean;
  /** The rule snapshot's tag flag. Default false, so existing tests never involve the tagger. */
  tag?: boolean;
  /** 'valid' stores an encrypted webhook pointing at the Slack stub; 'none' leaves the guild without one. */
  webhook?: 'valid' | 'none' | Buffer;
  postChannelId?: string | null;
  /** Milliseconds after the harness clock's now. Negative means already expired. */
  tokenExpiresInMs?: number;
}

/** Records a deferred report exactly as the request path would, then configures the guild around it. */
export async function seedReport(
  pool: pg.Pool,
  harness: Harness,
  options: SeedOptions = {},
): Promise<string> {
  const id = options.id ?? INTERACTION_ID;
  const payload: ReportJobPayload = {
    text: options.text ?? 'the printer is jammed',
    userId: USER_ID,
    channelId: CHANNEL_ID,
    ephemeral: options.ephemeral ?? true,
    replyMessage: 'Report logged. The team has been notified.',
    mirror: options.mirror ?? true,
    tag: options.tag ?? false,
  };
  const input: RecordInput = {
    interaction: {
      id,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      userId: USER_ID,
      type: 2,
      commandName: 'report',
      customId: null,
      options: { text: payload.text },
      status: 'deferred',
    },
    action: {
      type: 'report',
      summary: 'Logged a report.',
      mirrorStatus: payload.mirror ? 'pending' : 'skipped',
    },
    job: {
      kind: 'report',
      interactionToken: `${FAKE_INTERACTION_TOKEN}-${id}`,
      tokenExpiresAt: new Date(harness.clock.nowMs() + (options.tokenExpiresInMs ?? 870_000)),
      payload,
    },
  };
  await new PgLedger(pool).recordAndEnqueue(input);
  // The ledger stamps the database's now(); due-ness here is judged by the test clock, so align them.
  await pool.query('UPDATE job SET next_run_at = $2 WHERE interaction_id = $1', [
    id,
    new Date(harness.clock.nowMs()),
  ]);
  await configureGuild(pool, harness, options);
  return id;
}

async function configureGuild(
  pool: pg.Pool,
  harness: Harness,
  options: SeedOptions,
): Promise<void> {
  const webhook = options.webhook ?? 'valid';
  const blob =
    webhook === 'valid'
      ? harness.cipher.encrypt(slackWebhookUrl(harness), GUILD_ID)
      : webhook === 'none'
        ? null
        : webhook;
  await pool.query('UPDATE guild SET mirror_webhook_enc = $2, post_channel_id = $3 WHERE id = $1', [
    GUILD_ID,
    blob,
    options.postChannelId === undefined ? null : options.postChannelId,
  ]);
}

export function slackWebhookUrl(harness: Harness): string {
  return `${harness.slack.baseUrl}/services/T000/B000/${WEBHOOK_SECRET}`;
}

export interface JobRow {
  id: string;
  status: string;
  attempts: number;
  interaction_token: string | null;
  next_run_at: Date;
  claimed_at: Date | null;
  last_error: string | null;
  interaction_status: string;
  mirror_status: string;
}

export async function readJob(pool: pg.Pool, interactionId = INTERACTION_ID): Promise<JobRow> {
  const result = await pool.query<JobRow>(
    `SELECT j.id, j.status, j.attempts, j.interaction_token, j.next_run_at, j.claimed_at, j.last_error,
            i.status AS interaction_status, a.mirror_status
       FROM job j
       JOIN interaction i ON i.id = j.interaction_id
       JOIN action a ON a.interaction_id = j.interaction_id
      WHERE j.interaction_id = $1`,
    [interactionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No job for interaction ${interactionId}`);
  }
  return row;
}

export interface AttemptRow {
  attempt_no: number;
  target: string;
  outcome: string;
  http_status: number | null;
  error: string | null;
}

export async function readAttempts(
  pool: pg.Pool,
  interactionId = INTERACTION_ID,
): Promise<AttemptRow[]> {
  const result = await pool.query<AttemptRow>(
    `SELECT t.attempt_no, t.target, t.outcome, t.http_status, t.error
       FROM job_attempt t JOIN job j ON j.id = t.job_id
      WHERE j.interaction_id = $1
      ORDER BY t.attempt_no,
               CASE t.target WHEN 'tag' THEN 0 WHEN 'mirror' THEN 1 WHEN 'followup' THEN 2 ELSE 3 END`,
    [interactionId],
  );
  return result.rows;
}

/** A fresh database and fresh stubs for every test; returns the getter for the current harness. */
export function usePipeline(db: () => pg.Pool, options: HarnessOptions = {}): () => Harness {
  let current: Harness | undefined;
  beforeEach(async () => {
    await truncateAll(db());
    current = await startHarness(db(), options);
  });
  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });
  return () => {
    if (current === undefined) {
      throw new Error('The pipeline harness is not ready: its beforeEach hook failed.');
    }
    return current;
  };
}

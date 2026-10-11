import {
  describeFailure,
  describeTagFailure,
  MIRROR_UNREADABLE,
  PAYLOAD_UNREADABLE,
  withAttemptLimit,
  type FailureTarget,
} from '../domain/failureReasons.js';
import { mirrorMessage } from '../domain/mirrorMessage.js';
import { parseReportJobPayload, type ReportJobPayload } from '../domain/reportJob.js';
import { reportFallbackBody, reportResultBody } from '../domain/reportReplies.js';
import { classifyFailure, retryDelayMs, type CallFailure } from '../domain/retry.js';
import { isReportTag } from '../domain/tagging.js';
import {
  TagFallback,
  type AttemptOutcome,
  type AttemptTarget,
  type InteractionStatus,
} from '../domain/types.js';
import type { Clock } from '../ports/clock.js';
import type { DiscordClient } from '../ports/discord.js';
import type {
  AttemptRecord,
  ClaimedJob,
  JobRepository,
  StepEffect,
  StepNext,
} from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { Random } from '../ports/random.js';
import type { SlackMirror } from '../ports/slack.js';
import type { Tagger } from '../ports/tagger.js';
import { WebhookDecryptError, type WebhookCipher } from '../ports/webhookCipher.js';

export interface ReportJobRunnerOptions {
  appId: string;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface ReportJobRunnerDeps {
  jobs: JobRepository;
  discord: DiscordClient;
  slack: SlackMirror;
  /** Present only when LLM_ENABLED: without it the tagging step does nothing and no key is needed. */
  tagger?: Tagger | undefined;
  cipher: WebhookCipher;
  clock: Clock;
  random: Random;
}

/** The job and its logger: all a commit needs. */
interface JobContext {
  job: ClaimedJob;
  log: Logger;
}

/** Everything the steps share for one pass over one job. */
interface Pass extends JobContext {
  payload: ReportJobPayload;
  /** True when the Slack mirror ended in 'failed' (this pass or an earlier one): the job will finish dead. */
  mirrorFailed: boolean;
  /** `ACTION.llm_tag` as of this pass: what the mirror line may show once it is a real tag. */
  llmTag: string | null;
}

/**
 * One pass over a report job (DESIGN §11.3): tag, mirror, then edit the deferred reply, then, if the reply is
 * impossible, the channel fallback. Each step skips itself when its marker says it already happened, so a
 * retried job never repeats a Slack post, a successful edit or a Gemini call.
 *
 * Each step returns whether the pass goes on to the next one. The runner never throws for a failed call: the
 * outcome is written through `JobRepository.commitStep`. A throw means the database itself failed; the job
 * then stays `processing` and the lease expiry recovers it.
 */
export class ReportJobRunner {
  public constructor(
    private readonly deps: ReportJobRunnerDeps,
    private readonly options: ReportJobRunnerOptions,
  ) {}

  public async run(job: ClaimedJob, log: Logger): Promise<void> {
    const parsed = parseReportJobPayload(job.payload);
    if (!parsed.ok) {
      await this.giveUp({ job, log }, PAYLOAD_UNREADABLE);
      return;
    }
    if (job.attempts > this.options.maxAttempts) {
      // Reached only by a job whose workers keep dying mid-pass: each lease recovery counts as a pass.
      await this.giveUp({ job, log }, this.limitReached('The worker stopped before finishing.'));
      return;
    }
    const pass: Pass = {
      job,
      log,
      payload: parsed.payload,
      mirrorFailed: job.mirrorStatus === 'failed',
      llmTag: job.llmTag,
    };
    await this.tagStep(pass);
    if (!(await this.mirrorStep(pass)) || !(await this.followUpStep(pass))) {
      return;
    }
    await this.fallbackStep(pass);
  }

  // Step 1: the LLM tag ---------------------------------------------------------------------------------

  /**
   * One try, never retried (DESIGN §11.3): any failure writes `untagged` and the pass goes on, so the tag can
   * never delay or block the mirror, kill the job or be asked for twice. The marker is committed with its attempt
   * row before the mirror runs, so a later pass (a Slack retry) finds it set and does not call Gemini again.
   * Nothing the model says is logged, stored or sent unless it passed the enum check inside the adapter.
   */
  private async tagStep(pass: Pass): Promise<void> {
    const { tagger } = this.deps;
    if (tagger === undefined || !pass.payload.tag || pass.llmTag !== null) {
      return;
    }
    const startedAt = this.now();
    const result = await tagger.tag(pass.payload.text);
    if (result.ok) {
      const attempt = this.attempt(pass, 'tag', 'success', startedAt, result.status);
      await this.commit(pass, attempt, { llmTag: result.tag });
      pass.llmTag = result.tag;
      return;
    }
    const reason = describeTagFailure(result.failure);
    const status = result.failure.kind === 'http' ? result.failure.status : undefined;
    await this.commit(pass, this.attempt(pass, 'tag', 'fatal', startedAt, status, reason), {
      llmTag: TagFallback,
    });
    pass.llmTag = TagFallback;
  }

  // Step 2: the Slack mirror ----------------------------------------------------------------------------

  private async mirrorStep(pass: Pass): Promise<boolean> {
    const { job } = pass;
    if (job.mirrorStatus !== 'pending') {
      return true;
    }
    if (job.mirrorWebhookEnc === null) {
      // Nothing to call, so no attempt row: there is no attempt to show an admin.
      await this.commit(pass, null, { mirrorStatus: 'skipped' });
      return true;
    }
    const startedAt = this.now();
    const url = this.decryptWebhook(job.mirrorWebhookEnc, job.guildId);
    if (url === undefined) {
      return this.failMirror(pass, startedAt, undefined, MIRROR_UNREADABLE);
    }
    const result = await this.deps.slack.send(
      url,
      mirrorMessage({
        ...pass.payload,
        reportTag: isReportTag(pass.llmTag) ? pass.llmTag : undefined,
      }),
    );
    if (result.ok) {
      await this.commit(pass, this.attempt(pass, 'mirror', 'success', startedAt, result.status), {
        mirrorStatus: 'sent',
      });
      return true;
    }
    const reason = describeFailure('mirror', result.failure);
    if (classifyFailure(result.failure) === 'fatal') {
      return this.failMirror(pass, startedAt, result.failure, reason);
    }
    if (this.isLastAttempt(pass)) {
      return this.failMirror(pass, startedAt, result.failure, this.limitReached(reason));
    }
    await this.scheduleRetry(pass, 'mirror', startedAt, result.failure, reason);
    return false;
  }

  /** Never calls Slack again, but the user still gets an answer: the pass continues to the reply (§11.3). */
  private async failMirror(
    pass: Pass,
    startedAt: Date,
    failure: CallFailure | undefined,
    reason: string,
  ): Promise<boolean> {
    const attempt = this.attempt(pass, 'mirror', 'fatal', startedAt, failure?.status, reason);
    await this.commit(pass, attempt, { mirrorStatus: 'failed', lastError: reason });
    pass.mirrorFailed = true;
    return true;
  }

  private decryptWebhook(blob: Buffer, guildId: string): string | undefined {
    try {
      return this.deps.cipher.decrypt(blob, guildId);
    } catch (error) {
      if (error instanceof WebhookDecryptError) {
        return undefined;
      }
      throw error;
    }
  }

  // Step 3: edit the deferred reply ---------------------------------------------------------------------

  private async followUpStep(pass: Pass): Promise<boolean> {
    const { job, payload } = pass;
    const token = job.interactionToken;
    if (token === null || this.isTokenExpired(job)) {
      return true;
    }
    const startedAt = this.now();
    const result = await this.deps.discord.editOriginal(
      this.options.appId,
      token,
      reportResultBody({
        replyMessage: payload.replyMessage,
        mirrorFailed: pass.mirrorFailed,
        reportId: job.interactionId,
      }),
    );
    if (result.ok) {
      await this.commit(pass, this.attempt(pass, 'followup', 'success', startedAt, result.status), {
        next: this.finishOf(pass, 'followed_up'),
      });
      return false;
    }
    const reason = describeFailure('followup', result.failure);
    if (classifyFailure(result.failure) === 'fatal') {
      // 401/404 and every other 4xx: the token is no use, so clear it and answer in the channel now (§11.4).
      const attempt = this.attempt(
        pass,
        'followup',
        'fatal',
        startedAt,
        result.failure.status,
        reason,
      );
      await this.commit(pass, attempt, { clearToken: true, lastError: reason });
      return true;
    }
    await this.retryOrGiveUp(pass, 'followup', startedAt, result.failure, reason);
    return false;
  }

  // Step 4: channel fallback ----------------------------------------------------------------------------

  private async fallbackStep(pass: Pass): Promise<void> {
    const { job, payload } = pass;
    const startedAt = this.now();
    const result = await this.deps.discord.postChannelMessage(
      job.postChannelId ?? job.channelId,
      // Public message: reportFallbackBody leaves the report text out unless the report was public (§11.3).
      reportFallbackBody({
        userId: payload.userId,
        reference: job.interactionId,
        ephemeral: payload.ephemeral,
        text: payload.text,
      }),
    );
    if (result.ok) {
      await this.commit(pass, this.attempt(pass, 'fallback', 'success', startedAt, result.status), {
        next: this.finishOf(pass, 'fallback_posted'),
      });
      return;
    }
    const reason = describeFailure('fallback', result.failure);
    if (classifyFailure(result.failure) === 'fatal') {
      const attempt = this.attempt(
        pass,
        'fallback',
        'fatal',
        startedAt,
        result.failure.status,
        reason,
      );
      await this.commit(pass, attempt, { lastError: reason, next: DEAD_AND_FAILED });
      return;
    }
    await this.retryOrGiveUp(pass, 'fallback', startedAt, result.failure, reason);
  }

  // Shared outcomes -------------------------------------------------------------------------------------

  /** The end state of a job that answered the user (§11.3 "Finish"): dead only if the mirror failed. */
  private finishOf(pass: Pass, interactionStatus: InteractionStatus): StepNext {
    return { kind: 'finish', jobStatus: pass.mirrorFailed ? 'dead' : 'done', interactionStatus };
  }

  private async retryOrGiveUp(
    pass: Pass,
    target: FailureTarget,
    startedAt: Date,
    failure: CallFailure,
    reason: string,
  ): Promise<void> {
    if (!this.isLastAttempt(pass)) {
      await this.scheduleRetry(pass, target, startedAt, failure, reason);
      return;
    }
    const full = this.limitReached(reason);
    const attempt = this.attempt(pass, target, 'retryable', startedAt, failure.status, full);
    await this.commit(pass, attempt, { lastError: full, next: DEAD_AND_FAILED });
  }

  private async scheduleRetry(
    pass: Pass,
    target: FailureTarget,
    startedAt: Date,
    failure: CallFailure,
    reason: string,
  ): Promise<void> {
    const delayMs = retryDelayMs(
      failure,
      pass.job.attempts - 1,
      this.options.backoffBaseMs,
      this.options.backoffMaxMs,
      this.deps.random,
    );
    const runAt = new Date(this.deps.clock.nowMs() + delayMs);
    const attempt = this.attempt(pass, target, 'retryable', startedAt, failure.status, reason);
    await this.commit(pass, attempt, { lastError: reason, next: { kind: 'retry', runAt } });
    pass.log.warn({ target, delay_ms: delayMs, attempt: pass.job.attempts }, 'job.retry_scheduled');
  }

  /** A job that cannot be processed at all (unreadable payload, too many lost leases). */
  private async giveUp(context: JobContext, reason: string): Promise<void> {
    await this.commit(context, null, { lastError: reason, next: DEAD_AND_FAILED });
  }

  private async commit(
    context: JobContext,
    attempt: AttemptRecord | null,
    effect: StepEffect,
  ): Promise<void> {
    const result = await this.deps.jobs.commitStep(context.job, attempt, effect);
    if (result === 'lease_lost') {
      context.log.warn({}, 'job.lease_lost');
      return;
    }
    logOutcome(context.log, attempt, effect);
  }

  // Small helpers ---------------------------------------------------------------------------------------

  private attempt(
    pass: Pass,
    target: AttemptTarget,
    outcome: AttemptOutcome,
    startedAt: Date,
    httpStatus: number | undefined,
    error?: string,
  ): AttemptRecord {
    return {
      attemptNo: pass.job.attempts,
      target,
      outcome,
      httpStatus,
      error,
      startedAt,
      finishedAt: this.now(),
    };
  }

  private now(): Date {
    return new Date(this.deps.clock.nowMs());
  }

  private isTokenExpired(job: ClaimedJob): boolean {
    return job.tokenExpiresAt === null || job.tokenExpiresAt.getTime() <= this.deps.clock.nowMs();
  }

  private isLastAttempt(pass: Pass): boolean {
    return pass.job.attempts >= this.options.maxAttempts;
  }

  private limitReached(reason: string): string {
    return withAttemptLimit(reason, this.options.maxAttempts);
  }
}

/** The job gave up without a good answer reaching the user. */
const DEAD_AND_FAILED = {
  kind: 'finish',
  jobStatus: 'dead',
  interactionStatus: 'failed',
} as const satisfies StepNext;

/** One structured line per recorded call and per end state: ids and codes only, never text or tokens. */
function logOutcome(log: Logger, attempt: AttemptRecord | null, effect: StepEffect): void {
  if (attempt !== null) {
    log.info(
      {
        target: attempt.target,
        outcome: attempt.outcome,
        http_status: attempt.httpStatus,
        attempt: attempt.attemptNo,
      },
      'job.attempt',
    );
  }
  if (effect.next?.kind !== 'finish') {
    return;
  }
  const fields = {
    job_status: effect.next.jobStatus,
    interaction_status: effect.next.interactionStatus,
  };
  if (effect.next.jobStatus === 'dead') {
    log.error({ ...fields, reason: effect.lastError }, 'job.dead');
  } else {
    log.info(fields, 'job.done');
  }
}

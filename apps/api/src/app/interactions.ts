import type { InteractionResponse } from '../domain/discordProtocol.js';
import { deferMessage, message, pong } from '../domain/discordResponses.js';
import { errorLogFields } from '../domain/errorFields.js';
import { MESSAGES } from '../domain/messages.js';
import { statusText } from '../domain/status.js';
import {
  classify,
  INTERACTION_TYPE,
  parseInteraction,
  type RawInteraction,
  type RouteDecision,
} from '../domain/router.js';
import { evaluate } from '../domain/rules.js';
import { isTimestampFresh, verifySignature } from '../domain/signature.js';
import type { Action } from '../domain/types.js';
import type { Clock } from '../ports/clock.js';
import type { LedgerService, RecordInput, RecordOutcome } from '../ports/ledger.js';
import type { Logger } from '../ports/logger.js';
import type { StatusReader } from '../ports/status.js';
import { answeredRecord } from './answeredRecord.js';
import { withDeadline } from './deadline.js';
import { deferredReportRecord, readReportText } from './reportRecord.js';

/** What the HTTP layer hands over: the three signed inputs, exactly as received. */
export interface InboundInteraction {
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | undefined;
}

/**
 * 401 and 400 carry no body (CLAUDE.md). 200 carries the interaction response JSON.
 * 401 covers every authenticity failure (bad signature, stale timestamp) so a caller cannot tell them apart.
 */
export type InteractionResult =
  { status: 401 } | { status: 400 } | { status: 200; body: InteractionResponse };

export interface InteractionControllerOptions {
  publicKeyHex: string;
  replayWindowMs: number;
  statusTimeoutMs: number;
  /** Upper bound on recording an interaction; together with statusTimeoutMs it must fit inside 3 s. */
  recordTimeoutMs: number;
  clock: Clock;
  ledger: LedgerService;
  statusReader: StatusReader;
  /** Called after a job was committed, so an in-process worker need not wait for its next poll. */
  onJobEnqueued?: () => void;
}

/** What the HTTP layer depends on (DIP): the controller below, or a fake in tests. */
export interface InteractionHandler {
  handle(request: InboundInteraction, logger: Logger): Promise<InteractionResult>;
}

/**
 * The interactions endpoint, framework-free (DESIGN §7, §8.2).
 * Order is fixed by CLAUDE.md: verify signature, replay check, parse, PING, route, record, reply.
 * Nothing is read from the body, and nothing is stored, before the signature has been verified.
 */
export class InteractionController implements InteractionHandler {
  public constructor(private readonly options: InteractionControllerOptions) {}

  public async handle(request: InboundInteraction, logger: Logger): Promise<InteractionResult> {
    const { clock } = this.options;

    if (
      !verifySignature(
        request.timestamp,
        request.rawBody,
        request.signature,
        this.options.publicKeyHex,
      )
    ) {
      logger.warn({ logType: 'security' }, 'interaction.signature_rejected');
      return { status: 401 };
    }
    // Only now is the timestamp trustworthy: it is covered by the signature.
    if (
      request.timestamp === undefined ||
      !isTimestampFresh(request.timestamp, clock.nowMs(), this.options.replayWindowMs)
    ) {
      logger.warn({ logType: 'security' }, 'interaction.timestamp_rejected');
      return { status: 401 };
    }

    const interaction = parseBody(request.rawBody);
    if (interaction === undefined) {
      logger.warn({}, 'interaction.malformed');
      return { status: 400 };
    }

    const log = logger.child({ interaction_id: interaction.id });
    return { status: 200, body: await this.respond(interaction, log) };
  }

  private async respond(interaction: RawInteraction, log: Logger): Promise<InteractionResponse> {
    const decision = classify(interaction);
    switch (decision.kind) {
      case 'ping':
        log.info({}, 'interaction.ping');
        return pong();
      case 'command':
        return this.respondToCommand(interaction, decision, log);
      case 'component':
      case 'modalSubmit':
        // Buttons and modals arrive in Step 5. Until then nothing registers them, so say so honestly.
        log.warn({ kind: decision.kind }, 'interaction.unhandled_kind');
        return message(MESSAGES.unknownCommand, { ephemeral: true });
      case 'unsupported':
        return respondToUnsupported(interaction, log);
    }
  }

  private async respondToCommand(
    interaction: RawInteraction,
    decision: Extract<RouteDecision, { kind: 'command' }>,
    log: Logger,
  ): Promise<InteractionResponse> {
    log.info({ command: decision.name, guild_id: decision.tenant.guildId }, 'interaction.received');
    // No rule store yet: every command is enabled with its default config (DESIGN §8.3).
    const action = evaluate(decision.name, { enabled: true }, null);
    if (action.type === 'report') {
      return this.deferReport(interaction, decision, action, log);
    }
    // Persist before we answer (CLAUDE.md). If we cannot, say so: a fake success would be a lost command.
    const outcome = await this.record(answeredRecord(interaction.id, decision, action), log);
    if (outcome === 'failed') {
      return message(MESSAGES.notRecorded, { ephemeral: true });
    }
    return this.replyFor(action, decision.tenant.guildId, log);
  }

  /**
   * /report with text (DESIGN §5.2): record interaction, action and job in one transaction, then defer.
   * Nothing slow runs here; the worker mirrors to Slack and edits the deferred reply (CLAUDE.md, 3 s clock).
   */
  private async deferReport(
    interaction: RawInteraction,
    decision: Extract<RouteDecision, { kind: 'command' }>,
    action: Extract<Action, { type: 'report' }>,
    log: Logger,
  ): Promise<InteractionResponse> {
    const text = readReportText(decision.options);
    if (!text.ok) {
      const notice = text.reason === 'empty' ? MESSAGES.emptyReport : MESSAGES.reportTooLong;
      return message(notice, { ephemeral: true });
    }
    // Discord always sends a token with a command. Without one there is nothing to answer later.
    if (interaction.token === undefined) {
      log.warn({}, 'interaction.token_missing');
      return message(MESSAGES.notRecorded, { ephemeral: true });
    }
    const outcome = await this.record(
      deferredReportRecord({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        receivedAtMs: this.options.clock.nowMs(),
        decision,
        action,
        text: text.text,
      }),
      log,
    );
    if (outcome === 'failed') {
      return message(MESSAGES.notRecorded, { ephemeral: true });
    }
    if (outcome === 'won') {
      this.options.onJobEnqueued?.();
    }
    return deferMessage({ ephemeral: action.ephemeral });
  }

  /**
   * Dedupe + outbox write, bounded by the record timeout. 'won' and 'duplicate' both mean the interaction is
   * safely in the ledger: a duplicate still gets a normal reply and is not recorded again. 'failed' means
   * nothing can be promised. A write that is merely slow may still commit after we gave up: the user is then
   * told it was not logged, and the worker later edits that message with the result (DESIGN §9, rev 5).
   */
  private async record(input: RecordInput, log: Logger): Promise<RecordOutcome | 'failed'> {
    try {
      const outcome = await withDeadline(
        this.options.ledger.recordAndEnqueue(input),
        this.options.recordTimeoutMs,
      );
      if (outcome === 'duplicate') {
        log.info({}, 'interaction.duplicate');
      }
      return outcome;
    } catch (error) {
      // Name and code only: a database error's message can quote the row, and a job row holds the token.
      log.error(errorLogFields(error), 'ledger.record_failed');
      return 'failed';
    }
  }

  private async replyFor(
    action: Exclude<Action, { type: 'report' }>,
    guildId: string,
    log: Logger,
  ): Promise<InteractionResponse> {
    switch (action.type) {
      case 'status':
        return this.statusReply(guildId, action.ephemeral, log);
      case 'disabled':
        return message(MESSAGES.disabled, { ephemeral: true });
      case 'unknown_command':
        return message(MESSAGES.unknownCommand, { ephemeral: true });
    }
  }

  /** The one inline fast path (DESIGN §5.1): a bounded read, then type 4. Never waits past the budget. */
  private async statusReply(
    guildId: string,
    ephemeral: boolean,
    log: Logger,
  ): Promise<InteractionResponse> {
    try {
      const counts = await withDeadline(
        this.options.statusReader.read(guildId),
        this.options.statusTimeoutMs,
      );
      return message(statusText(counts), { ephemeral });
    } catch (error) {
      log.error(errorLogFields(error), 'status.read_failed');
      return message(MESSAGES.statusUnavailable, { ephemeral: true });
    }
  }
}

function parseBody(rawBody: Buffer | undefined): RawInteraction | undefined {
  if (rawBody === undefined) {
    return undefined;
  }
  try {
    return parseInteraction(JSON.parse(rawBody.toString('utf8')));
  } catch {
    return undefined;
  }
}

/** A DM has no guild; any other unsupported shape is answered like an unknown command. */
function respondToUnsupported(interaction: RawInteraction, log: Logger): InteractionResponse {
  if (interaction.type !== INTERACTION_TYPE.PING && interaction.guild_id === undefined) {
    log.info({}, 'interaction.dm_rejected');
    return message(MESSAGES.dmUnsupported, { ephemeral: true });
  }
  log.warn({ type: interaction.type }, 'interaction.unsupported');
  return message(MESSAGES.unknownCommand, { ephemeral: true });
}

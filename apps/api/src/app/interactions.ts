import type { InteractionResponse } from '../domain/discordProtocol.js';
import { message, pong } from '../domain/discordResponses.js';
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
import type { Logger } from '../ports/logger.js';
import type { StatusReader } from '../ports/status.js';
import { withDeadline } from './deadline.js';

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
  clock: Clock;
  statusReader: StatusReader;
}

/** What the HTTP layer depends on (DIP): the controller below, or a fake in tests. */
export interface InteractionHandler {
  handle(request: InboundInteraction, logger: Logger): Promise<InteractionResult>;
}

/**
 * The interactions endpoint, framework-free (DESIGN §7, §8.2).
 * Order is fixed by CLAUDE.md: verify signature, replay check, parse, PING, route, reply.
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
        return this.respondToCommand(decision, log);
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
    decision: Extract<RouteDecision, { kind: 'command' }>,
    log: Logger,
  ): Promise<InteractionResponse> {
    log.info({ command: decision.name, guild_id: decision.tenant.guildId }, 'interaction.received');
    // Step 1 has no rule store: every command is enabled with its default config (DESIGN §8.3).
    const action = evaluate(decision.name, { enabled: true }, null);
    return this.replyFor(action, decision.tenant.guildId, log);
  }

  private async replyFor(
    action: Action,
    guildId: string,
    log: Logger,
  ): Promise<InteractionResponse> {
    switch (action.type) {
      case 'status':
        return this.statusReply(guildId, action.ephemeral, log);
      case 'disabled':
        return message(MESSAGES.disabled, { ephemeral: true });
      case 'unknown_command':
      case 'report':
        // /report is not registered until Step 3; if it arrives anyway it is treated as unknown.
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
      // Name only: the message of a database error can carry connection details.
      log.error(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'status.read_failed',
      );
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

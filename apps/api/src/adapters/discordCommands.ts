import { z } from 'zod';

import type { CommandDefinition } from '../domain/commands.js';

export interface RegisterGuildCommandsOptions {
  apiBaseUrl: string;
  appId: string;
  guildId: string;
  /** A real secret. Used only for the Authorization header; never logged and never put in an error. */
  botToken: string;
  commands: readonly CommandDefinition[];
  timeoutMs: number;
  /** Injected so tests never touch the network. */
  fetchFn?: typeof fetch;
}

/** A registration failure in port-level terms (resilience skill): an HTTP status, or timeout / network. */
export class CommandRegistrationError extends Error {
  public readonly status: number | undefined;
  public readonly kind: 'timeout' | 'network' | undefined;
  /** Discord's own numeric error code (JSON error codes), when the body had one. */
  public readonly discordCode: number | undefined;

  public constructor(
    message: string,
    details: { status?: number; kind?: 'timeout' | 'network'; discordCode?: number },
  ) {
    super(message);
    this.name = 'CommandRegistrationError';
    this.status = details.status;
    this.kind = details.kind;
    this.discordCode = details.discordCode;
  }
}

const USER_AGENT = 'DiscordBot (the-report-line, 0.1.0)'; // Discord asks for this shape on every API call
const MAX_ERROR_BODY_BYTES = 4096; // a Discord error is a few hundred bytes; never buffer more
const MAX_DISCORD_MESSAGE_LENGTH = 200;
const MAX_DISCORD_FIELD_PATHS = 5;

/** Discord JSON error codes that change the advice (docs.discord.com, topics/opcodes-and-status-codes). */
const DISCORD_CODE = {
  UNKNOWN_APPLICATION: 10002,
  UNKNOWN_GUILD: 10004,
  MISSING_ACCESS: 50001,
  INVALID_FORM_BODY: 50035,
} as const;

interface DiscordErrorBody {
  code: number | undefined;
  message: string | undefined;
  /** Dotted paths of the invalid fields (names only, from the `errors` tree). */
  fields: string[];
  retryAfterSeconds: number | undefined;
}

/**
 * Reads the error body and keeps only the first MAX_ERROR_BODY_BYTES characters. The read is bounded in time by
 * the fetch signal; a hand-run script talking to Discord does not need streaming byte limits.
 */
async function readBoundedText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    // A body that cannot be read just means no extra detail; the status still explains the failure.
    return '';
  }
}

function collectFieldPaths(node: unknown, prefix: string, into: string[]): void {
  if (typeof node !== 'object' || node === null || into.length >= MAX_DISCORD_FIELD_PATHS) {
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === '_errors') {
      if (prefix !== '') {
        into.push(prefix);
      }
      continue;
    }
    collectFieldPaths(child, prefix === '' ? key : `${prefix}.${key}`, into);
  }
}

/** Each field falls back to undefined on its own, so one odd value never hides the others. */
const DiscordErrorSchema = z.looseObject({
  code: z.number().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  errors: z.unknown().optional(),
  retry_after: z.number().optional().catch(undefined),
});

/** Pulls the documented error fields out of the body. Anything else in it is ignored, never printed. */
export function parseDiscordErrorBody(text: string): DiscordErrorBody {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { code: undefined, message: undefined, fields: [], retryAfterSeconds: undefined };
  }
  const parsed = DiscordErrorSchema.safeParse(json);
  if (!parsed.success) {
    return { code: undefined, message: undefined, fields: [], retryAfterSeconds: undefined };
  }
  const fields: string[] = [];
  collectFieldPaths(parsed.data.errors, '', fields);
  return {
    code: parsed.data.code,
    message: parsed.data.message?.slice(0, MAX_DISCORD_MESSAGE_LENGTH),
    fields,
    retryAfterSeconds: parsed.data.retry_after,
  };
}

/** What the person running the script should try next, by status and Discord code. */
export function registrationHint(status: number, discordCode: number | undefined): string {
  if (status === 401) {
    return 'The bot token was refused. Reset it in the Developer Portal (Bot page) and update DISCORD_BOT_TOKEN.';
  }
  if (discordCode === DISCORD_CODE.UNKNOWN_APPLICATION) {
    return 'Check DISCORD_APP_ID: it must be the Application ID from General Information.';
  }
  if (discordCode === DISCORD_CODE.UNKNOWN_GUILD) {
    return 'Check DISCORD_GUILD_ID, and make sure the bot has been invited to that server.';
  }
  if (status === 403 || status === 404 || discordCode === DISCORD_CODE.MISSING_ACCESS) {
    return (
      'Invite the bot to the server first, using an invite with both the "bot" and "applications.commands" scopes, ' +
      'then check DISCORD_GUILD_ID and DISCORD_APP_ID.'
    );
  }
  if (status === 400 || discordCode === DISCORD_CODE.INVALID_FORM_BODY) {
    return 'Discord did not accept the command definitions. This is a bug in the definitions, not in your setup.';
  }
  if (status === 429) {
    return 'Discord is rate limiting command registration. Wait a little and run it again.';
  }
  if (status >= 500) {
    return 'Discord had a problem on its side. Run the script again in a minute.';
  }
  return 'Check the values in your environment file and try again.';
}

/** One human-readable line: status, Discord's code and message, any bad field names, and the hint. */
export function describeRegistrationFailure(
  status: number,
  body: DiscordErrorBody,
  botToken: string,
): string {
  const detail = [
    `HTTP ${String(status)}`,
    body.code === undefined ? undefined : `Discord code ${String(body.code)}`,
    body.message === undefined ? undefined : `"${body.message}"`,
    body.fields.length === 0 ? undefined : `fields: ${body.fields.join(', ')}`,
    body.retryAfterSeconds === undefined
      ? undefined
      : `retry after ${String(body.retryAfterSeconds)}s`,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
  const text = `Discord rejected the command registration (${detail}). ${registrationHint(status, body.code)}`;
  // Defence in depth: Discord does not echo the Authorization header, but a secret must never reach output.
  return botToken === '' ? text : text.replaceAll(botToken, '[redacted]');
}

/**
 * Replaces the guild's whole command set (`PUT` is a bulk overwrite, so it is idempotent). Guild commands
 * are available instantly, unlike global ones (DESIGN §4). Resolves on 200; otherwise throws
 * `CommandRegistrationError` carrying the status, Discord's code and message, and a hint, never a credential.
 */
export async function registerGuildCommands(options: RegisterGuildCommandsOptions): Promise<void> {
  const url = `${options.apiBaseUrl}/applications/${options.appId}/guilds/${options.guildId}/commands`;
  const send = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await send(url, {
      method: 'PUT',
      headers: {
        authorization: `Bot ${options.botToken}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(options.commands),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    throw new CommandRegistrationError(
      isTimeout
        ? 'Discord did not answer in time. Check your network and run the script again.'
        : 'Could not reach Discord. Check your network connection (and DISCORD_API_BASE_URL if you set it).',
      { kind: isTimeout ? 'timeout' : 'network' },
    );
  }
  if (response.status === 200) {
    await response.body?.cancel();
    return;
  }
  const body = parseDiscordErrorBody(await readBoundedText(response));
  throw new CommandRegistrationError(
    describeRegistrationFailure(response.status, body, options.botToken),
    { status: response.status, ...(body.code === undefined ? {} : { discordCode: body.code }) },
  );
}

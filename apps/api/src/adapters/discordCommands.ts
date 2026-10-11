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

  public constructor(message: string, details: { status?: number; kind?: 'timeout' | 'network' }) {
    super(message);
    this.name = 'CommandRegistrationError';
    this.status = details.status;
    this.kind = details.kind;
  }
}

const USER_AGENT = 'DiscordBot (the-report-line, 0.1.0)'; // Discord asks for this shape on every API call

/**
 * Replaces the guild's whole command set (`PUT` is a bulk overwrite, so it is idempotent). Guild commands
 * are available instantly, unlike global ones (DESIGN §4). Resolves on 200; otherwise throws
 * `CommandRegistrationError` without echoing the response body or any credential.
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
        ? 'Discord did not answer in time.'
        : 'Could not reach Discord. Check your network connection.',
      { kind: isTimeout ? 'timeout' : 'network' },
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel(); // never read, never print: a body could echo what we sent
    throw new CommandRegistrationError(
      `Discord rejected the command registration (status ${String(response.status)}).`,
      { status: response.status },
    );
  }
}

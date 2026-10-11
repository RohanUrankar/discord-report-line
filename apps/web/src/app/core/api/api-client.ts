import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  GuildList,
  GuildSettings,
  GuildSummary,
  InteractionDetail,
  InteractionLogPage,
  RuleList,
  RuleView,
  SessionInfo,
  type CommandName,
  type JobStatus,
  type LoginRequest,
  type UpdateGuildSettingsRequest,
} from '@report-line/shared';
import type { ZodType } from 'zod';
import { firstValueFrom } from 'rxjs';

import { API_BASE } from '../constants/app.constants';
import { AppError } from '../errors/app-error';
import { messageForCode } from '../errors/error-messages';

export interface LogQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: JobStatus;
}

export interface RuleUpdate {
  readonly enabled: boolean;
  readonly config: unknown;
}

const seg = (value: string): string => encodeURIComponent(value);

/**
 * The only place that talks to the network (frontend-guidelines). Every response is parsed with the schema
 * from @report-line/shared that the server builds it from, so a drifting contract fails here, loudly and
 * as one error shape, instead of as `undefined` somewhere in a template. Errors arrive already mapped to
 * AppError by the error interceptor.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  login(body: LoginRequest): Promise<SessionInfo> {
    return this.send(SessionInfo, 'POST', '/auth/login', body);
  }

  me(): Promise<SessionInfo> {
    return this.send(SessionInfo, 'GET', '/auth/me');
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post<null>(`${API_BASE}/auth/logout`, null));
  }

  listGuilds(): Promise<GuildList> {
    return this.send(GuildList, 'GET', '/guilds');
  }

  connectGuild(guildId: string): Promise<GuildSummary> {
    return this.send(GuildSummary, 'POST', '/guilds', { guildId });
  }

  listInteractions(guildId: string, query: LogQuery = {}): Promise<InteractionLogPage> {
    let params = new HttpParams();
    if (query.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    if (query.cursor !== undefined) {
      params = params.set('cursor', query.cursor);
    }
    if (query.status !== undefined) {
      params = params.set('status', query.status);
    }
    return this.send(
      InteractionLogPage,
      'GET',
      `/guilds/${seg(guildId)}/interactions`,
      undefined,
      params,
    );
  }

  getInteraction(guildId: string, interactionId: string): Promise<InteractionDetail> {
    return this.send(
      InteractionDetail,
      'GET',
      `/guilds/${seg(guildId)}/interactions/${seg(interactionId)}`,
    );
  }

  getSettings(guildId: string): Promise<GuildSettings> {
    return this.send(GuildSettings, 'GET', `/guilds/${seg(guildId)}/settings`);
  }

  updateSettings(guildId: string, body: UpdateGuildSettingsRequest): Promise<GuildSettings> {
    return this.send(GuildSettings, 'PUT', `/guilds/${seg(guildId)}/settings`, body);
  }

  listRules(guildId: string): Promise<RuleList> {
    return this.send(RuleList, 'GET', `/guilds/${seg(guildId)}/rules`);
  }

  updateRule(guildId: string, command: CommandName, body: RuleUpdate): Promise<RuleView> {
    return this.send(RuleView, 'PUT', `/guilds/${seg(guildId)}/rules/${seg(command)}`, body);
  }

  private async send<T>(
    schema: ZodType<T>,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    params?: HttpParams,
  ): Promise<T> {
    const raw = await firstValueFrom(
      this.http.request<unknown>(method, `${API_BASE}${path}`, {
        ...(body === undefined ? {} : { body }),
        ...(params === undefined ? {} : { params }),
      }),
    );
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError({
        code: 'BAD_RESPONSE',
        message: messageForCode('BAD_RESPONSE'),
        status: 200,
      });
    }
    return parsed.data;
  }
}

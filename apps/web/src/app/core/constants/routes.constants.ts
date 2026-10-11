/** Route paths in one place (frontend-guidelines: no magic strings in components). */
export const ROUTE = {
  login: '/login',
  connect: '/connect',
  home: '/',
} as const;

export const guildPath = (guildId: string): string => `/g/${guildId}`;
export const logPath = (guildId: string): string => `${guildPath(guildId)}/log`;
export const interactionPath = (guildId: string, interactionId: string): string =>
  `${logPath(guildId)}/${interactionId}`;
export const settingsPath = (guildId: string): string => `${guildPath(guildId)}/settings`;
export const rulesPath = (guildId: string): string => `${guildPath(guildId)}/rules`;

export const RETURN_URL_PARAM = 'returnUrl';
export const FILTER_PARAM = 'filter';
export const FILTER_ATTENTION = 'attention';

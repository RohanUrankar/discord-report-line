import { CSRF_HEADER, LOG_PAGE_SIZE_DEFAULT } from '@report-line/shared';

/** Every API call is relative to this: the SPA and the API share one origin (CLAUDE.md, dashboard auth). */
export const API_BASE = '/api';
export const API_PREFIX = `${API_BASE}/`;

export const CSRF_HEADER_NAME = CSRF_HEADER;

/** How often page 1 of the live log is refreshed while the tab is visible. */
export const POLL_INTERVAL_MS = 5_000;
/** Waits after the 1st, then every later, failed poll: 5s -> 10s -> 30s overall. */
export const POLL_BACKOFF_MS: readonly number[] = [10_000, 30_000];
/** The most log rows kept in memory; the oldest fall off (and "Load older" stops) beyond it. */
export const LOG_LIST_CAP = 500;
export const LOG_PAGE_SIZE = LOG_PAGE_SIZE_DEFAULT;

/** Relative times ("2 min ago") are recomputed this often. */
export const CLOCK_TICK_MS = 30_000;
/** Scrolled further than this and new rows wait behind the "N new" button instead of moving the list. */
export const LIVE_HOLD_SCROLL_PX = 160;

export const SNACKBAR_SUCCESS_MS = 4_000;

/** UX-only checks; the server stays authoritative. */
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
/** A Discord id, or nothing (an emptied field clears the setting). */
export const OPTIONAL_SNOWFLAKE_PATTERN = /^(?:\d{17,20})?$/;
export const REPLY_MESSAGE_MAX = 300;

/** Characters of a Discord id shown when no name is known; the full id stays in the title/detail. */
export const SHORT_ID_LENGTH = 6;

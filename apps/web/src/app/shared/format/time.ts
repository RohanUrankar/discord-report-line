const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const JUST_NOW_MS = 45 * SECOND;
const RELATIVE_LIMIT_DAYS = 7;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. Future times (clock skew) read as "just now". */
export function relativeTime(thenMs: number, nowMs: number): string {
  const age = nowMs - thenMs;
  if (age < JUST_NOW_MS) {
    return 'just now';
  }
  if (age < HOUR) {
    return `${String(Math.max(1, Math.round(age / MINUTE)))} min ago`;
  }
  if (age < DAY) {
    return `${String(Math.round(age / HOUR))} h ago`;
  }
  if (age < RELATIVE_LIMIT_DAYS * DAY) {
    return `${String(Math.round(age / DAY))} d ago`;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(thenMs);
}

/** The full local date and time, for tooltips and the detail page. */
export function absoluteTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
    Date.parse(iso),
  );
}

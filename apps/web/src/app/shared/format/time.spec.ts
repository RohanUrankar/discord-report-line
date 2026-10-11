import { absoluteTime, relativeTime } from './time';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const ago = (ms: number): number => NOW - ms;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it.each([
    [10 * SECOND, 'just now'],
    [-5 * SECOND, 'just now'],
    [2 * MINUTE, '2 min ago'],
    [59 * MINUTE, '59 min ago'],
    [3 * HOUR, '3 h ago'],
    [2 * DAY, '2 d ago'],
  ])('shows %s ms ago as "%s"', (age, text) => {
    expect(relativeTime(ago(age), NOW)).toBe(text);
  });

  it('switches to the date after a week', () => {
    expect(relativeTime(ago(9 * DAY), NOW)).toMatch(/2026/);
  });

  it('gives the exact local time for the tooltip', () => {
    expect(absoluteTime('2026-10-12T10:00:00.000Z')).toMatch(/2026/);
  });
});

/** Cuts `text` to `max` characters, ending in "…". Counts code points so an emoji is never split. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

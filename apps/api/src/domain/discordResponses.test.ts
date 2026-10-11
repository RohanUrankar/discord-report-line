import { describe, expect, it } from 'vitest';

import { deferMessage, deferUpdate, message, pong, updateMessage } from './discordResponses.js';

describe('interaction responses', () => {
  it('PING is answered with exactly {type: 1}', () => {
    expect(pong()).toEqual({ type: 1 });
  });

  it('builds an ephemeral type 4 message with mentions disabled', () => {
    expect(message('Hello', { ephemeral: true })).toEqual({
      type: 4,
      data: { content: 'Hello', allowed_mentions: { parse: [] }, flags: 64 },
    });
  });

  it('builds a public type 4 message without flags', () => {
    expect(message('Hello', { ephemeral: false })).toEqual({
      type: 4,
      data: { content: 'Hello', allowed_mentions: { parse: [] } },
    });
  });

  it('never lets user text ping everyone', () => {
    const response = message('@everyone look', { ephemeral: false });
    expect(response).toMatchObject({ data: { allowed_mentions: { parse: [] } } });
  });

  it('truncates content to Discord’s 2000-character limit', () => {
    const response = message('a'.repeat(2500), { ephemeral: false });
    expect(response.type === 4 && Array.from(response.data.content).length).toBe(2000);
  });

  it('does not split an emoji when truncating', () => {
    const response = message('😀'.repeat(2001), { ephemeral: false });
    expect(response.type === 4 && response.data.content.endsWith('😀…')).toBe(true);
  });

  it('defers ephemerally with flag 64 as the only data', () => {
    expect(deferMessage({ ephemeral: true })).toEqual({ type: 5, data: { flags: 64 } });
  });

  it('defers publicly with no data', () => {
    expect(deferMessage({ ephemeral: false })).toEqual({ type: 5 });
  });

  it('defers a component update with type 6', () => {
    expect(deferUpdate()).toEqual({ type: 6 });
  });

  it('updates a message with type 7, mentions disabled and no flags', () => {
    expect(updateMessage('Acknowledged')).toEqual({
      type: 7,
      data: { content: 'Acknowledged', allowed_mentions: { parse: [] }, components: [] },
    });
  });
});

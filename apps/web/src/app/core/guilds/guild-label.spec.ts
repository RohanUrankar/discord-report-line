import { guildLabel, shortId } from './guild-label';

describe('guild labels', () => {
  it('uses the name when the bot knows it', () => {
    expect(guildLabel({ id: '111111111111111111', name: 'Team Server' })).toBe('Team Server');
  });

  it('WHEN the name is null THE UI SHALL fall back to the end of the id', () => {
    expect(guildLabel({ id: '123456789012345678', name: null })).toBe('Server …345678');
  });

  it('does not shorten an id that is already short', () => {
    expect(shortId('1234')).toBe('1234');
  });
});

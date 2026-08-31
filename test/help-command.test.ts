import { describe, expect, it } from 'vitest';
import { parseHelpCommand } from '../src/adapters/telegram-command';

describe('parseHelpCommand', () => {
  it.each(['/help', ' /help ', '/start', '\n/start\t'])('accepts an exact onboarding command: %j', (input) => {
    expect(parseHelpCommand(input)).toEqual({ status: 'valid' });
  });

  it.each(['/help extra', '/start extra', '/help@some_bot', '/helper', 'ordinary text'])(
    'ignores text that is not an exact onboarding command: %j',
    (input) => {
      expect(parseHelpCommand(input)).toEqual({ status: 'not_help' });
    }
  );
});

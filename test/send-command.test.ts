import { describe, expect, it } from 'vitest';
import { parseSendCommand } from '../src/adapters/telegram-command';

describe('parseSendCommand', () => {
  it('extracts the first argument as mailbox and preserves internal message spacing', () => {
    expect(parseSendCommand('  /send Box.Example.  hello   world  ')).toEqual({
      status: 'valid',
      mailbox: 'Box.Example.',
      text: 'hello   world'
    });
  });

  it.each([
    '/send@my_bot box.example message',
    '/send@other_bot box.example message',
    '/send@_ box.example message'
  ])('ignores a bot-addressed command until the bot identity is configured: %j', (input) => {
    expect(parseSendCommand(input)).toEqual({ status: 'not_send' });
  });

  it.each([
    '/send',
    '/send   ',
    '/send box.example',
    '/send box.example   ',
    '/send   box.example\t \n  '
  ])('classifies a missing mailbox or non-whitespace text as malformed: %j', (input) => {
    expect(parseSendCommand(input)).toEqual({ status: 'malformed' });
  });

  it.each(['/inbox box.example', 'ordinary text', '/sender box.example message']) (
    'ignores text that is not the send command: %j',
    (input) => {
      expect(parseSendCommand(input)).toEqual({ status: 'not_send' });
    }
  );
});

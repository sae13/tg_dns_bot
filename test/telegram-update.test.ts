import { describe, expect, it } from 'vitest';
import { parseTelegramUpdate } from '../src/domain/telegram-update';

describe('parseTelegramUpdate message text', () => {
  it('carries exact Telegram message text to the application boundary', () => {
    expect(parseTelegramUpdate({
      update_id: 42,
      message: { message_id: 7, text: '/send Box.Example.  hello   world  ' }
    })).toEqual({
      status: 'valid',
      update: { updateId: 42, kind: 'message', text: '/send Box.Example.  hello   world  ' }
    });
  });

  it('carries the Telegram sender identity needed for attribution and rate limiting', () => {
    expect(parseTelegramUpdate({
      update_id: 43,
      message: {
        message_id: 8,
        text: '/send box.example.com سلام',
        from: { id: 9_007_199_254_740_991, username: 'sender' }
      }
    })).toEqual({
      status: 'valid',
      update: {
        updateId: 43,
        kind: 'message',
        text: '/send box.example.com سلام',
        senderId: 9_007_199_254_740_991,
        senderUsername: 'sender'
      }
    });
  });

  it('carries a safe originating chat id without changing sender attribution', () => {
    expect(parseTelegramUpdate({
      update_id: 46,
      message: {
        message_id: 11,
        text: '/inbox box.example',
        chat: { id: -100_000_000_001 },
        from: { id: 42, username: 'reader' }
      }
    })).toEqual({
      status: 'valid',
      update: {
        updateId: 46,
        kind: 'message',
        text: '/inbox box.example',
        chatId: -100_000_000_001,
        senderId: 42,
        senderUsername: 'reader'
      }
    });
  });

  it.each([0, 9_007_199_254_740_992, -9_007_199_254_740_992])(
    'rejects an invalid or unsafe originating chat id: %s',
    (chatId) => {
      expect(parseTelegramUpdate({
        update_id: 47,
        message: { message_id: 12, chat: { id: chatId } }
      })).toEqual({ status: 'invalid' });
    }
  );

  it('does not synthesize text or sender identity when Telegram omits them', () => {
    expect(parseTelegramUpdate({ update_id: 44, message: { message_id: 9, photo: [] } })).toEqual({
      status: 'valid',
      update: { updateId: 44, kind: 'message' }
    });
  });

  it('rejects an unsafe Telegram sender id rather than losing precision', () => {
    expect(parseTelegramUpdate({
      update_id: 45,
      message: { message_id: 10, text: '/send box.example.com text', from: { id: 9_007_199_254_740_992 } }
    })).toEqual({ status: 'invalid' });
  });
});

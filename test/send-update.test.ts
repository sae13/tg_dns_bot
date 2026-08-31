import { describe, expect, it, vi } from 'vitest';
import { createSendUpdateHandler, type SendRequestPort } from '../src/application/handle-update';
import { createAllowedZoneMap } from '../src/domain/mailbox';
import type { TelegramUpdate } from '../src/domain/telegram-update';

const message = (text?: string): TelegramUpdate => text === undefined
  ? { updateId: 1, kind: 'message' }
  : { updateId: 1, kind: 'message', text, senderId: 42 };

function portSpy(): SendRequestPort & { accept: ReturnType<typeof vi.fn> } {
  return { accept: vi.fn(async () => undefined) };
}

describe('createSendUpdateHandler', () => {
  it('passes one canonical, zone-routed request with Telegram identity while preserving spacing', async () => {
    const port = portSpy();
    const handler = createSendUpdateHandler({
      sendEnabled: true,
      allowedZones: () => createAllowedZoneMap([['example.com', 'zone-1'], ['other.test', 'zone-2']])
    }, port);

    const update: TelegramUpdate = {
      updateId: 91,
      kind: 'message',
      text: '/send Box.Example.COM.  hello   world  ',
      senderId: 42,
      senderUsername: 'sender'
    };
    const request = {
      updateId: 91,
      mailbox: 'box.example.com',
      zoneId: 'zone-1',
      text: 'hello   world',
      senderId: 42,
      senderUsername: 'sender'
    };
    const result = await handler.handle(update);
    expect(result).toEqual({ status: 'accepted', request });
    expect(port.accept).toHaveBeenCalledOnce();
    expect(port.accept).toHaveBeenCalledWith(request);
  });

  it('rejects a send command without a Telegram sender before any side effect', async () => {
    const port = portSpy();
    const allowedZones = vi.fn(() => createAllowedZoneMap([['example.com', 'zone-1']]));
    const handler = createSendUpdateHandler({ sendEnabled: true, allowedZones }, port);

    await expect(handler.handle({
      updateId: 1, kind: 'message', text: '/send box.example.com text'
    })).resolves.toEqual({ status: 'invalid_sender' });
    expect(allowedZones).not.toHaveBeenCalled();
    expect(port.accept).not.toHaveBeenCalled();
  });

  it('returns disabled before deep parsing or loading allowed zones', async () => {
    const port = portSpy();
    const allowedZones = vi.fn(() => { throw new Error('must not load'); });
    const handler = createSendUpdateHandler({ sendEnabled: false, allowedZones }, port);

    await expect(handler.handle(message('/send https://bad.invalid ignored'))).resolves.toEqual({ status: 'disabled' });
    expect(allowedZones).not.toHaveBeenCalled();
    expect(port.accept).not.toHaveBeenCalled();
  });

  it.each(['/send', '/send example.com', '/send example.com   '])(
    'classifies malformed send input without a side effect: %j',
    async (text) => {
      const port = portSpy();
      const allowedZones = vi.fn(() => createAllowedZoneMap([['example.com', 'zone-1']]));
      const handler = createSendUpdateHandler({ sendEnabled: true, allowedZones }, port);

      await expect(handler.handle(message(text))).resolves.toEqual({ status: 'malformed' });
      expect(allowedZones).not.toHaveBeenCalled();
      expect(port.accept).not.toHaveBeenCalled();
    }
  );

  it.each(['evil-example.com', 'https://example.com', '127.0.0.1', 'other.test'])(
    'classifies an invalid or unauthorized mailbox without a side effect: %s',
    async (mailbox) => {
      const port = portSpy();
      const handler = createSendUpdateHandler({
        sendEnabled: true,
        allowedZones: () => createAllowedZoneMap([['example.com', 'zone-1']])
      }, port);

      await expect(handler.handle(message(`/send ${mailbox} text`))).resolves.toEqual({ status: 'invalid_mailbox' });
      expect(port.accept).not.toHaveBeenCalled();
    }
  );

  it.each([
    { updateId: 1, kind: 'callback_query' },
    { updateId: 1, kind: 'message' },
    { updateId: 1, kind: 'message', text: 'ordinary text' }
  ] satisfies TelegramUpdate[])('ignores unsupported content without loading zones or effects', async (update) => {
    const port = portSpy();
    const allowedZones = vi.fn(() => createAllowedZoneMap([['example.com', 'zone-1']]));
    const handler = createSendUpdateHandler({ sendEnabled: true, allowedZones }, port);

    await expect(handler.handle(update)).resolves.toEqual({ status: 'ignored' });
    expect(allowedZones).not.toHaveBeenCalled();
    expect(port.accept).not.toHaveBeenCalled();
  });
});

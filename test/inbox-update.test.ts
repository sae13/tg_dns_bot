import { describe, expect, it, vi } from 'vitest';
import { createInboxUpdateHandler } from '../src/application/handle-update';
import type { TxtResolution, TxtResolverPort } from '../src/application/txt-resolver';
import { encodeManagedMessage } from '../src/domain/managed-message-codec';
import { createManagedMessageEnvelope } from '../src/domain/managed-message';
import type { TelegramUpdate } from '../src/domain/telegram-update';

function message(text: string): TelegramUpdate {
  return { updateId: 1, kind: 'message', text, senderId: 42 };
}

function resolver(result: TxtResolution = { status: 'nodata' }): TxtResolverPort & {
  resolveTxt: ReturnType<typeof vi.fn>;
} {
  return { resolveTxt: vi.fn(async () => result) };
}

function managedWire(text: string): string {
  return encodeManagedMessage(createManagedMessageEnvelope({
    id: '123e4567-e89b-42d3-a456-426614174000',
    i: 1,
    n: 1,
    uid: 42,
    sentAt: new Date('2026-08-30T12:15:12.345Z'),
    text
  }));
}

describe('createInboxUpdateHandler', () => {
  it('preserves the originating Telegram chat identity with a reconstructed result', async () => {
    const port = resolver();
    const handler = createInboxUpdateHandler({ readEnabled: true }, port);

    await expect(handler.handle({
      updateId: 1,
      kind: 'message',
      text: '/inbox box.example',
      chatId: -10042,
      senderId: 42
    })).resolves.toMatchObject({
      status: 'resolved',
      name: 'box.example',
      chatId: -10042,
      inbox: { status: 'absent' }
    });
  });

  it('canonicalizes and reconstructs one exact name outside the write allowlist', async () => {
    const wire = managedWire('public');
    const resolution: TxtResolution = {
      status: 'found',
      records: [{ name: 'shop.xn--bcher-kva.example', ttl: 60, value: wire }]
    };
    const port = resolver(resolution);
    const handler = createInboxUpdateHandler({ readEnabled: true }, port);

    await expect(handler.handle(message('/inbox Shop.BÜCHER.example.'))).resolves.toMatchObject({
      status: 'resolved',
      name: 'shop.xn--bcher-kva.example',
      inbox: {
        status: 'complete',
        name: 'shop.xn--bcher-kva.example',
        message: {
          id: '123e4567-e89b-42d3-a456-426614174000',
          uid: 42,
          username: null,
          ts: '2026-08-30T12:15:12.345Z',
          text: 'public'
        },
        queries: [{ name: 'shop.xn--bcher-kva.example', resolution }]
      }
    });
    expect(port.resolveTxt).toHaveBeenCalledOnce();
    expect(port.resolveTxt).toHaveBeenCalledWith('shop.xn--bcher-kva.example');
  });

  it('returns disabled before validating the name or querying DNS', async () => {
    const port = resolver();
    const handler = createInboxUpdateHandler({ readEnabled: false }, port);

    await expect(handler.handle(message('/inbox https://invalid.example')))
      .resolves.toEqual({ status: 'read_disabled' });
    expect(port.resolveTxt).not.toHaveBeenCalled();
  });

  it.each([
    ['/inbox', 'malformed_inbox'],
    ['/inbox   ', 'malformed_inbox'],
    ['/inbox box.example extra', 'malformed_inbox'],
    ['/inbox https://example.com', 'invalid_inbox_name'],
    ['/inbox 127.0.0.1', 'invalid_inbox_name'],
    ['/inbox bad..example', 'invalid_inbox_name']
  ] as const)('rejects invalid input with the exact typed status: %j', async (text, expectedStatus) => {
    const port = resolver();
    const handler = createInboxUpdateHandler({ readEnabled: true }, port);

    await expect(handler.handle(message(text))).resolves.toEqual({ status: expectedStatus });
    expect(port.resolveTxt).not.toHaveBeenCalled();
  });

  it.each([
    { updateId: 1, kind: 'callback_query' },
    { updateId: 1, kind: 'message' },
    { updateId: 1, kind: 'message', text: 'ordinary text' },
    { updateId: 1, kind: 'message', text: '/send box.example text' },
    { updateId: 1, kind: 'message', text: '/inbox@some_bot box.example' }
  ] satisfies TelegramUpdate[])('ignores content that is not an unaddressed inbox command', async (update) => {
    const port = resolver();
    const handler = createInboxUpdateHandler({ readEnabled: true }, port);

    await expect(handler.handle(update)).resolves.toEqual({ status: 'ignored' });
    expect(port.resolveTxt).not.toHaveBeenCalled();
  });
});

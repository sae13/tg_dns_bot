import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendRequestPort } from '../src/application/handle-update';
import type { Env } from '../src/config';
import { createWorker } from '../src/index';

const secret = 'test-webhook-secret';
const headers = { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' };

afterEach(() => vi.restoreAllMocks());

function webhook(text: string): Request {
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      update_id: 91,
      message: { message_id: 1, text, from: { id: 42, username: 'sender' } }
    })
  });
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_WEBHOOK_SECRET: secret,
    SEND_ENABLED: 'true',
    ALLOWED_ZONE_MAP: '[["example.com","zone-1"],["other.test","zone-2"]]',
    ...overrides
  };
}

function portSpy(): SendRequestPort & { accept: ReturnType<typeof vi.fn> } {
  return { accept: vi.fn(async () => undefined) };
}

describe('Worker send command composition', () => {
  it('wires Telegram text through parsing and mailbox routing to the send port', async () => {
    const port = portSpy();
    const response = await createWorker(undefined, port).fetch(
      webhook('/send Box.Example.COM.  hello   world  '), env(), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(port.accept).toHaveBeenCalledOnce();
    expect(port.accept).toHaveBeenCalledWith({
      updateId: 91,
      mailbox: 'box.example.com',
      zoneId: 'zone-1',
      text: 'hello   world',
      senderId: 42,
      senderUsername: 'sender'
    });
  });

  it.each([
    ['/send', 'true', '[["example.com","zone-1"]]'],
    ['/send example.com', 'true', '[["example.com","zone-1"]]'],
    ['/send evil-example.com text', 'true', '[["example.com","zone-1"]]'],
    ['/send https://example.com text', 'true', '[["example.com","zone-1"]]'],
    ['/send 127.0.0.1 text', 'true', '[["example.com","zone-1"]]'],
    ['/send example.com text', 'false', 'not-json']
  ])('has no external side effect for rejected input %#', async (text, enabled, zoneMap) => {
    const port = portSpy();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not run'));
    const response = await createWorker(undefined, port).fetch(
      webhook(text), env({ SEND_ENABLED: enabled, ALLOWED_ZONE_MAP: zoneMap }), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(port.accept).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('canonicalizes an internationalized mailbox before routing it', async () => {
    const port = portSpy();
    const response = await createWorker(undefined, port).fetch(
      webhook('/send shop.bücher.example سلام'),
      env({ ALLOWED_ZONE_MAP: '[["xn--bcher-kva.example","zone-idn"]]' }),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(port.accept).toHaveBeenCalledWith({
      updateId: 91,
      mailbox: 'shop.xn--bcher-kva.example',
      zoneId: 'zone-idn',
      text: 'سلام',
      senderId: 42,
      senderUsername: 'sender'
    });
  });

  it('fails closed on malformed enabled configuration without calling the send port', async () => {
    const port = portSpy();
    const response = await createWorker(undefined, port).fetch(
      webhook('/send example.com text'), env({ ALLOWED_ZONE_MAP: 'not-json' }), {} as ExecutionContext
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_misconfigured' });
    expect(port.accept).not.toHaveBeenCalled();
  });
});

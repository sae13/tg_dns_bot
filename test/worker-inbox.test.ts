import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';
import { createWorker } from '../src/index';
import { encodeManagedMessage } from '../src/domain/managed-message-codec';
import { createManagedMessageEnvelope } from '../src/domain/managed-message';

const webhookSecret = 'test-webhook-secret';
const cloudflareWriteSecret = 'write-secret-must-not-be-used-for-reading';
const headers = {
  'x-telegram-bot-api-secret-token': webhookSecret,
  'content-type': 'application/json'
};

function webhook(text: string): Request {
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      update_id: 92,
      message: { message_id: 1, text, from: { id: 42 } }
    })
  });
}

function webhookWithChat(text: string, chatId = -10042): Request {
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      update_id: 92,
      message: { message_id: 1, text, chat: { id: chatId }, from: { id: 42 } }
    })
  });
}

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    SEND_ENABLED: 'false',
    READ_ENABLED: 'true',
    ALLOWED_ZONE_MAP: 'not-json',
    CLOUDFLARE_API_TOKEN: cloudflareWriteSecret,
    ...overrides
  };
}

function managedWire(text: string, index: number, count: number): string {
  return encodeManagedMessage(createManagedMessageEnvelope({
    id: '123e4567-e89b-42d3-a456-426614174000',
    i: index,
    n: count,
    uid: 42,
    username: 'sender_name',
    sentAt: new Date('2026-08-30T12:15:12.345Z'),
    text
  }));
}

function dnsFound(name: string, values: readonly string[]): Response {
  return Response.json({
    Status: 0,
    Question: [{ name: `${name}.`, type: 16 }],
    Answer: values.map((value) => ({
      name: `${name}.`,
      type: 16,
      TTL: 60,
      data: (value.match(/.{1,255}/gu) ?? ['']).map((part) => `"${part}"`).join(' ')
    }))
  }, { headers: { 'content-type': 'application/dns-json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('Worker inbox command composition', () => {
  it('reads an exact public TXT name through Cloudflare DoH without write configuration or credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      Status: 0,
      Question: [{ name: 'outside.example.', type: 16 }],
      Answer: [{ name: 'outside.example.', type: 16, TTL: 60, data: '"public"' }]
    }, { headers: { 'content-type': 'application/dns-json' } }));

    const response = await createWorker().fetch(
      webhook('/inbox OUTSIDE.example.'), workerEnv(), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.hostname).toBe('cloudflare-dns.com');
    expect(url.searchParams.get('name')).toBe('outside.example');
    expect(url.searchParams.get('type')).toBe('TXT');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(cloudflareWriteSecret);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('not-json');
  });

  it('follows only manifest-derived numbered names through the real Worker composition', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const name = new URL(String(input)).searchParams.get('name');
      if (name === 'outside.example') {
        return dnsFound(name, ['unrelated', managedWire('first-', 1, 3)]);
      }
      if (name === '2.outside.example') return dnsFound(name, [managedWire('second-', 2, 3)]);
      if (name === '3.outside.example') return dnsFound(name, [managedWire('third', 3, 3)]);
      throw new Error(`unexpected query: ${name}`);
    });

    const response = await createWorker().fetch(
      webhook('/inbox outside.example'), workerEnv(), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('name'))).toEqual([
      'outside.example',
      '2.outside.example',
      '3.outside.example'
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(cloudflareWriteSecret);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('not-json');
  });

  it('works when the Cloudflare write token is completely absent', async () => {
    const withoutWriteToken = workerEnv();
    delete withoutWriteToken.CLOUDFLARE_API_TOKEN;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      Status: 0,
      Question: [{ name: 'outside.example.', type: 16 }],
      Answer: [{ name: 'outside.example.', type: 16, TTL: 60, data: '"public"' }]
    }, { headers: { 'content-type': 'application/dns-json' } }));

    const response = await createWorker().fetch(
      webhook('/inbox outside.example'), withoutWriteToken, {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns the reconstructed inbox through the webhook without calling Telegram outbound', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') {
        return dnsFound('outside.example', [managedWire('سلام <raw>', 1, 1)]);
      }
      throw new Error('outbound Telegram API must not run');
    });

    const response = await createWorker().fetch(
      webhookWithChat('/inbox outside.example'),
      workerEnv({
        BOT_TOKEN: '123:bot-secret',
        TELEGRAM_API_BASE_URL: 'https://api.telegram.test'
      }),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const reply = await response.json() as Record<string, unknown>;
    expect(reply).toMatchObject({ method: 'sendMessage', chat_id: -10042 });
    expect(reply.parse_mode).toBeUndefined();
    expect(String(reply.text)).toContain('کامل');
    expect(String(reply.text)).toContain('سلام <raw>');
  });

  it('returns a Telegram-safe first chunk for a long result without calling Telegram outbound', async () => {
    const messageText = 'سلام🙂'.repeat(900);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') {
        return dnsFound('outside.example', [managedWire(messageText, 1, 1)]);
      }
      throw new Error('outbound Telegram API must not run');
    });

    const response = await createWorker().fetch(
      webhookWithChat('/inbox outside.example'), workerEnv(), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const reply = await response.json() as Record<string, unknown>;
    expect(reply).toMatchObject({ method: 'sendMessage', chat_id: -10042 });
    expect(Array.from(String(reply.text)).length).toBeLessThanOrEqual(4_096);
    expect(String(reply.text)).toMatch(/^\[1\/\d+\]\n/u);
  });

  it('does not send a reply when the originating message has no chat identity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') return dnsFound('outside.example', ['public']);
      throw new Error('Telegram must not be called');
    });

    const response = await createWorker().fetch(
      webhook('/inbox outside.example'),
      workerEnv({ BOT_TOKEN: '123:bot-secret', TELEGRAM_API_BASE_URL: 'https://api.telegram.test' }),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not expose credentials or inbox text through logs while returning a webhook reply', async () => {
    const botToken = '123:bot-secret-never-log';
    const inboxText = 'private-inbox-text-never-log';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') {
        return dnsFound('outside.example', [managedWire(inboxText, 1, 1)]);
      }
      throw new Error('outbound Telegram API must not run');
    });

    const response = await createWorker().fetch(
      webhookWithChat('/inbox outside.example'),
      workerEnv({ BOT_TOKEN: botToken, TELEGRAM_API_BASE_URL: 'https://api.telegram.test' }),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ method: 'sendMessage', chat_id: -10042 });
    const logs = JSON.stringify(consoleSpy.mock.calls);
    expect(logs).not.toContain(botToken);
    expect(logs).not.toContain(inboxText);
  });

  it.each([
    ['/inbox https://invalid.example', 'true'],
    ['/inbox outside.example', 'false']
  ])('does not query DNS for rejected or disabled input %#', async (text, enabled) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not run'));

    const response = await createWorker().fetch(
      webhook(text), workerEnv({ READ_ENABLED: enabled }), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

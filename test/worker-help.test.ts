import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendRequestPort } from '../src/application/handle-update';
import type { Env } from '../src/config';
import { createWorker } from '../src/index';

const webhookSecret = 'test-webhook-secret';
const headers = {
  'x-telegram-bot-api-secret-token': webhookSecret,
  'content-type': 'application/json'
};

function webhook(text: string, includeChat = true): Request {
  return new Request('https://worker.test/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      update_id: 301,
      message: {
        message_id: 1,
        text,
        ...(includeChat ? { chat: { id: -10042 } } : {}),
        from: { id: 42 }
      }
    })
  });
}

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    BOT_TOKEN: '123:bot-secret',
    TELEGRAM_API_BASE_URL: 'https://api.telegram.test',
    HELP_ENABLED: 'true',
    SEND_ENABLED: 'false',
    READ_ENABLED: 'false',
    ALLOWED_ZONE_MAP: '[["Example.COM.","zone-id-never-show"],["other.test","second-zone-id"]]',
    DNS_TTL_SECONDS: '120',
    ...overrides
  };
}

function portSpy(): SendRequestPort & { accept: ReturnType<typeof vi.fn> } {
  return { accept: vi.fn(async () => undefined) };
}

afterEach(() => vi.restoreAllMocks());

describe('Worker help and operational response composition', () => {
  it.each(['/help', '/start'])('delivers actionable onboarding for %s as safe plain text', async (command) => {
    const sent: Record<string, unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    });

    const response = await createWorker().fetch(webhook(command), workerEnv(), {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({ chat_id: -10042 });
    expect(sent[0]?.parse_mode).toBeUndefined();
    const text = String(sent[0]?.text);
    expect(text).toContain('/send box.example.com متن پیام');
    expect(text).toContain('/inbox box.example.com');
    expect(text).toContain('example.com');
    expect(text).toContain('other.test');
    expect(text).toContain('فقط آخرین پیام همان صندوق را نگه میدارد و تاریخچه ندارد');
    expect(text).toContain('به دامنههای مجاز نوشتن محدود نیست');
    expect(text).toContain('هرکس نام صندوق را بداند');
    expect(text).toContain('محرمانه نیست');
    expect(text).toContain('گذرواژه');
    expect(text).toContain('زمان حافظهٔ نهان برحسب ثانیه:');
    expect(text).toContain('\n120');
    expect(text).not.toContain('zone-id-never-show');
    expect(text).not.toContain('second-zone-id');
    expect(text).not.toContain('bot-secret');
  });

  it('returns only the disabled response without parsing invalid dependent settings', async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

    const response = await createWorker().fetch(
      webhook('/help'),
      workerEnv({
        HELP_ENABLED: 'false',
        ALLOWED_ZONE_MAP: 'not-json',
        DNS_TTL_SECONDS: 'not-a-number'
      }),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({ chat_id: -10042, text: 'راهنما اکنون غیرفعال است. لطفاً بعداً دوباره تلاش کنید.' });
  });

  it('reports disabled sending without requiring a coordinator binding or zone settings', async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    const environment = workerEnv({ SEND_ENABLED: 'false', ALLOWED_ZONE_MAP: 'not-json' });
    delete environment.COORDINATOR;

    const response = await createWorker().fetch(
      webhook('/send https://bad.invalid ignored'), environment, {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({
      chat_id: -10042,
      text: 'ارسال پیام اکنون غیرفعال است. لطفاً بعداً دوباره تلاش کنید.'
    });
  });

  it.each([
    ['/send', 'نام کامل صندوق و متن پیام را وارد کنید.'],
    ['/send outside.invalid text', 'نام صندوق معتبر نیست یا در یکی از دامنههای مجاز نوشتن قرار ندارد.']
  ])('reports rejected enabled sending without requiring a coordinator binding: %s', async (command, warning) => {
    const sent: Record<string, unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    const environment = workerEnv({ SEND_ENABLED: 'true' });
    delete environment.COORDINATOR;

    const response = await createWorker().fetch(webhook(command), environment, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(sent[0]?.text)).toContain(warning);
  });

  it.each([
    ['/send', { SEND_ENABLED: 'true' }],
    ['/send box.example.com', { SEND_ENABLED: 'true' }],
    ['/send outside.invalid text', { SEND_ENABLED: 'true' }],
    ['/send https://bad.invalid ignored', { SEND_ENABLED: 'false', ALLOWED_ZONE_MAP: 'not-json' }],
    ['/inbox', { READ_ENABLED: 'true' }],
    ['/inbox https://bad.invalid', { READ_ENABLED: 'true' }],
    ['/inbox outside.example', { READ_ENABLED: 'false' }]
  ] as const)('delivers an operational warning without provider or coordinator effects: %s', async (command, overrides) => {
    const port = portSpy();
    const sent: Record<string, unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.telegram.test');
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

    const response = await createWorker(undefined, port).fetch(
      webhook(command), workerEnv(overrides), {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(port.accept).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sent[0]?.chat_id).toBe(-10042);
    expect(sent[0]?.parse_mode).toBeUndefined();
    expect(String(sent[0]?.text).length).toBeGreaterThan(10);
  });

  it('does not call Telegram when a help command has no chat identity', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not run'));
    const response = await createWorker().fetch(webhook('/help', false), workerEnv(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

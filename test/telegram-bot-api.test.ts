import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramBotApiAdapter,
  TelegramDeliveryError
} from '../src/adapters/telegram-bot-api';

afterEach(() => vi.restoreAllMocks());

describe('TelegramBotApiAdapter', () => {
  it('sends numbered chunks sequentially as plain text without parse mode', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        chat_id: -10042,
        text: calls.length === 1 ? '[1/2]\nfirst' : '[2/2]\nsecond'
      });
      return Response.json({ ok: true, result: { message_id: calls.length } });
    });
    const adapter = new TelegramBotApiAdapter({
      botToken: '123:secret-token',
      apiBaseUrl: 'https://api.telegram.test',
      fetcher
    });

    await adapter.sendChunks(-10042, ['[1/2]\nfirst', '[2/2]\nsecond'], 'corr-1');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/bot123:secret-token/sendMessage');
    expect(calls[1]).toContain('/bot123:secret-token/sendMessage');
  });

  it('reports a redacted structured event with correlation and failed chunk metadata', async () => {
    const events: unknown[] = [];
    const adapter = new TelegramBotApiAdapter({
      botToken: '123:secret-token',
      fetcher: vi.fn(async () => Response.json(
        { ok: false, description: 'private provider body' },
        { status: 200 }
      )),
      logger: (event) => { events.push(event); }
    });

    await expect(adapter.sendChunks(42, ['private message body'], 'corr-log'))
      .rejects.toBeInstanceOf(TelegramDeliveryError);
    expect(events).toEqual([{
      correlationId: 'corr-log',
      chunkIndex: 1,
      chunkCount: 1,
      outcome: 'failure',
      errorType: 'api_error'
    }]);
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect(JSON.stringify(events)).not.toContain('private message body');
    expect(JSON.stringify(events)).not.toContain('private provider body');
  });

  it.each([
    ['network_error', vi.fn(async () => { throw new Error('network failed'); })],
    ['network_error', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }))]
  ] as const)('maps rejected or timed-out fetch to %s with redacted metadata', async (kind, fetcher) => {
    const adapter = new TelegramBotApiAdapter({
      botToken: '123:secret-token',
      timeoutMilliseconds: 1,
      fetcher
    });

    await expect(adapter.sendChunks(42, ['private body'], 'corr-network')).rejects.toMatchObject({
      correlationId: 'corr-network',
      chunkIndex: 1,
      errorType: kind
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    [503, { ok: true, result: { message_id: 1 } }, 'http_error'],
    [200, 'not-json-object', 'invalid_response'],
    [200, { ok: true }, 'invalid_response']
  ] as const)('classifies HTTP and malformed responses safely (%s)', async (status, payload, errorType) => {
    const fetcher = vi.fn(async () => Response.json(payload, { status }));
    const adapter = new TelegramBotApiAdapter({ botToken: '123:secret-token', fetcher });

    await expect(adapter.sendChunks(42, ['body'], 'corr-response')).rejects.toMatchObject({
      correlationId: 'corr-response',
      chunkIndex: 1,
      errorType
    });
  });

  it('reports only correlation id and one-based failed chunk on delivery failure', async () => {
    const fetcher = vi.fn(async () => Response.json(
      { ok: false, description: 'private token and payload details' },
      { status: 200 }
    ));
    const adapter = new TelegramBotApiAdapter({
      botToken: '123:secret-token',
      apiBaseUrl: 'https://api.telegram.test',
      fetcher
    });

    await expect(adapter.sendChunks(42, ['secret body'], 'corr-failure'))
      .rejects.toMatchObject({
        name: 'TelegramDeliveryError',
        correlationId: 'corr-failure',
        chunkIndex: 1
      });
    try {
      await adapter.sendChunks(42, ['secret body'], 'corr-failure-2');
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramDeliveryError);
      expect(String(error)).not.toContain('secret-token');
      expect(String(error)).not.toContain('secret body');
      expect(String(error)).not.toContain('private token');
    }
  });

  it('stops in order at the first failed chunk', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      return calls === 2
        ? Response.json({ ok: false }, { status: 200 })
        : Response.json({ ok: true, result: { message_id: calls } });
    });
    const adapter = new TelegramBotApiAdapter({ botToken: '123:token', fetcher });

    await expect(adapter.sendChunks(42, ['one', 'two', 'three'], 'corr-stop'))
      .rejects.toMatchObject({ correlationId: 'corr-stop', chunkIndex: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized or empty chunk before exposing the bot token to fetch', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }));
    const adapter = new TelegramBotApiAdapter({ botToken: '123:secret-token', fetcher });

    await expect(adapter.sendChunks(42, ['ش'.repeat(4_097)], 'corr-large')).rejects.toThrow(TypeError);
    await expect(adapter.sendChunks(42, [''], 'corr-empty')).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

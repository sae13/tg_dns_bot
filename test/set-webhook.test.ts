import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWebhook } from '../scripts/set-webhook';

const options = {
  botToken: 'secret-bot-token',
  webhookSecret: 'secret-header-token',
  webhookUrl: 'https://bot.example/webhook'
};

afterEach(() => vi.restoreAllMocks());

describe('registerWebhook', () => {
  it('sends URL and secret to exact methods and verifies registration', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { url: options.webhookUrl } }));
    const logSpy = vi.spyOn(console, 'log');

    await registerWebhook({ ...options, fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.telegram.org/botsecret-bot-token/setWebhook');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ url: options.webhookUrl, secret_token: options.webhookSecret })
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.telegram.org/botsecret-bot-token/getWebhookInfo');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(options.botToken);
  });

  it('rejects when Telegram reports a different webhook URL', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { url: 'https://attacker.example/webhook' } }));

    await expect(registerWebhook({ ...options, fetchImpl: fetchMock }))
      .rejects.toThrow('Telegram webhook verification failed');
  });

  it('rejects a null webhook-info result as a controlled verification failure', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: null }));

    await expect(registerWebhook({ ...options, fetchImpl: fetchMock }))
      .rejects.toThrow('Telegram webhook verification failed');
  });

  it('reports a non-JSON HTTP error without leaking its response body', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<html>gateway failure</html>', { status: 502 }));

    await expect(registerWebhook({ ...options, fetchImpl: fetchMock }))
      .rejects.toThrow('Telegram returned HTTP 502');
  });

  it('reports malformed success JSON as a controlled error', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    await expect(registerWebhook({ ...options, fetchImpl: fetchMock }))
      .rejects.toThrow('Telegram returned an invalid JSON response');
  });

  it('rejects an API-level setWebhook failure without verification', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, description: 'rejected' }));

    await expect(registerWebhook({ ...options, fetchImpl: fetchMock }))
      .rejects.toThrow('Telegram webhook registration failed');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('normalizes an API base URL with a trailing slash', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { url: options.webhookUrl } }));

    await registerWebhook({ ...options, apiBaseUrl: 'https://api.telegram.org/', fetchImpl: fetchMock });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.telegram.org/botsecret-bot-token/setWebhook');
  });

  it('rejects invalid options before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(registerWebhook({ ...options, webhookUrl: 'http://bot.example/webhook', fetchImpl: fetchMock }))
      .rejects.toThrow('Webhook URL must be a public HTTPS URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

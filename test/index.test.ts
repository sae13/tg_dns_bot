import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateHandler } from '../src/application/handle-update';
import type { Env } from '../src/config';
import { createWorker } from '../src/index';

const workerEnv = env as Env;
const validHeaders = { 'x-telegram-bot-api-secret-token': 'test-webhook-secret', 'content-type': 'application/json' };

afterEach(() => vi.restoreAllMocks());

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://worker.test${path}`, init);
}

describe('Worker', () => {
  it('serves health through the deployed module entrypoint', async () => {
    const response = await SELF.fetch('https://worker.test/health');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('routes webhook authentication through the deployed module entrypoint', async () => {
    const response = await SELF.fetch('https://worker.test/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"update_id":1,"message":{"message_id":1}}'
    });
    expect(response.status).toBe(401);
  });

  it('returns a public health response without external calls or secrets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
    const response = await createWorker().fetch!(request('/health'), workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, 'wrong-secret'])('rejects missing or invalid secret before parsing the body', async (secret) => {
    const headers = secret ? { 'x-telegram-bot-api-secret-token': secret } : {};
    const webhookRequest = request('/webhook', { method: 'POST', headers, body: '{"update_id":1,"message":{"message_id":1}}' });
    const jsonSpy = vi.spyOn(webhookRequest, 'json');
    const response = await createWorker().fetch!(webhookRequest, workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('delivers a valid update exactly once', async () => {
    const handler: UpdateHandler = { handle: vi.fn(async () => undefined) };
    const response = await createWorker(handler).fetch!(request('/webhook', { method: 'POST', headers: validHeaders, body: '{"update_id":42,"message":{"message_id":1}}' }), workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(handler.handle).toHaveBeenCalledOnce();
    expect(handler.handle).toHaveBeenCalledWith({ updateId: 42, kind: 'message' });
  });

  it('rejects malformed JSON without handling or network calls', async () => {
    const handler: UpdateHandler = { handle: vi.fn(async () => undefined) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
    const response = await createWorker(handler).fetch!(request('/webhook', { method: 'POST', headers: validHeaders, body: '{' }), workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(handler.handle).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('safely ignores a structurally valid but unsupported update', async () => {
    const handler: UpdateHandler = { handle: vi.fn(async () => undefined) };
    const response = await createWorker(handler).fetch!(request('/webhook', { method: 'POST', headers: validHeaders, body: '{"update_id":43,"poll":{"id":"x"}}' }), workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('rejects a structurally invalid update', async () => {
    const response = await createWorker().fetch!(request('/webhook', { method: 'POST', headers: validHeaders, body: '{"message":{}}' }), workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_payload' });
  });

  it.each([undefined, ''])('fails closed when the webhook secret binding is missing or empty', async (secret) => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missingSecretEnv: Env = { ...workerEnv };
    if (secret === undefined) delete missingSecretEnv.TELEGRAM_WEBHOOK_SECRET;
    else missingSecretEnv.TELEGRAM_WEBHOOK_SECRET = secret;
    const response = await createWorker().fetch!(request('/webhook', { method: 'POST', body: '{"update_id":1,"message":{"message_id":1}}' }), missingSecretEnv, {} as ExecutionContext);
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(text).not.toContain('test-webhook-secret');
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('test-webhook-secret');
  });

  it('converts application errors to a controlled response', async () => {
    const handler: UpdateHandler = { handle: vi.fn(async () => { throw new Error('private detail'); }) };
    const response = await createWorker(handler).fetch!(request('/webhook', { method: 'POST', headers: validHeaders, body: '{"update_id":2,"message":{"message_id":1}}' }), workerEnv, {} as ExecutionContext);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private detail');
  });
});

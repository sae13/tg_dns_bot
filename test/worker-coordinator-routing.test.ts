import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';
import { createWorker } from '../src/index';

const workerEnv = env as Env;
const headers = {
  'x-telegram-bot-api-secret-token': 'test-webhook-secret',
  'content-type': 'application/json'
};

function webhook(updateId: number, mailbox: string, senderId = 42): RequestInit {
  return {
    method: 'POST',
    headers,
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        text: `/send ${mailbox} message-${updateId}`,
        from: { id: senderId, username: `user${senderId}` }
      }
    })
  };
}

describe('Worker coordinator routing', () => {
  it('routes a canonical mailbox to its named Durable Object with complete request data', async () => {
    const mailbox = 'box.example.com';
    const namespace = workerEnv.COORDINATOR;
    if (namespace === undefined) throw new Error('missing test coordinator binding');
    const target = namespace.get(namespace.idFromName(mailbox));
    let routedRequest: Request | undefined;
    const fakeNamespace = {
      idFromName: vi.fn((name: string) => namespace.idFromName(name)),
      get: vi.fn(() => ({
        fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          routedRequest = new Request(input, init);
          return Response.json({ status: 'published', sequence: 1, publicationStatus: 'committed' });
        })
      }))
    } as unknown as DurableObjectNamespace;
    const localEnv: Env = {
      ...workerEnv,
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      SEND_ENABLED: 'true',
      ALLOWED_ZONE_MAP: '[["example.com","zone-1"]]',
      COORDINATOR: fakeNamespace
    };

    const response = await createWorker().fetch(
      new Request('https://worker.test/webhook', webhook(81, 'Box.Example.COM.')),
      localEnv,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(fakeNamespace.idFromName).toHaveBeenCalledWith(mailbox);
    expect(fakeNamespace.get).toHaveBeenCalledOnce();
    expect(routedRequest).toBeDefined();
    expect(new URL(routedRequest!.url).pathname).toBe('/coordinate');
    await expect(routedRequest!.json()).resolves.toEqual({
      updateId: 81,
      mailbox,
      zoneId: 'zone-1',
      text: 'message-81',
      senderId: 42,
      senderUsername: 'user42'
    });

    await runInDurableObject(target, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(new Map());
    });
  });

  it('uses different Durable Object identities for different canonical mailboxes', async () => {
    const namespace = workerEnv.COORDINATOR;
    if (namespace === undefined) throw new Error('missing test coordinator binding');
    const first = namespace.idFromName('one.example.com');
    const second = namespace.idFromName('two.example.com');
    expect(first.equals(second)).toBe(false);
  });

  it('acknowledges a rate-limited coordinator response without retrying the update', async () => {
    const namespace = workerEnv.COORDINATOR;
    if (namespace === undefined) throw new Error('missing test coordinator binding');
    const fakeNamespace = {
      idFromName: (name: string) => namespace.idFromName(name),
      get: () => ({
        fetch: async () => Response.json({
          status: 'rate_limited', limitedBy: 'sender', retryAfterSeconds: 60
        }, { status: 429 })
      })
    } as unknown as DurableObjectNamespace;
    const localEnv: Env = {
      ...workerEnv,
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      SEND_ENABLED: 'true',
      ALLOWED_ZONE_MAP: '[["example.com","zone-1"]]',
      COORDINATOR: fakeNamespace
    };

    const response = await createWorker().fetch(
      new Request('https://worker.test/webhook', webhook(83, 'box.example.com')),
      localEnv,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('routes duplicate coordinator results without a second publication failure', async () => {
    const namespace = workerEnv.COORDINATOR;
    if (namespace === undefined) throw new Error('missing test coordinator binding');
    const coordinatorFetch = vi.fn(async () => Response.json({ status: 'duplicate', sequence: 1 }));
    const localEnv: Env = {
      ...workerEnv,
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      SEND_ENABLED: 'true',
      ALLOWED_ZONE_MAP: '[["example.com","zone-1"]]',
      COORDINATOR: {
        idFromName: (name: string) => namespace.idFromName(name),
        get: () => ({ fetch: coordinatorFetch })
      } as unknown as DurableObjectNamespace
    };

    const response = await createWorker().fetch(
      new Request('https://worker.test/webhook', webhook(84, 'box.example.com')),
      localEnv,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    expect(coordinatorFetch).toHaveBeenCalledOnce();
  });

  it('rejects a missing coordinator binding without attempting publication', async () => {
    const localEnv: Env = {
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      SEND_ENABLED: 'true',
      ALLOWED_ZONE_MAP: '[["example.com","zone-1"]]'
    };
    const response = await createWorker().fetch(
      new Request('https://worker.test/webhook', webhook(82, 'box.example.com')),
      localEnv,
      {} as ExecutionContext
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'service_misconfigured' });
  });
});

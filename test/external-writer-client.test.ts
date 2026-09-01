import { describe, expect, it, vi } from 'vitest';
import { ExternalWriterClient, ExternalWriterError } from '../src/adapters/external-writer-client';

const request = {
  updateId: 91,
  mailbox: 'box.example.com',
  zoneId: 'zone-1',
  text: 'hello',
  senderId: 42,
  senderUsername: 'sender'
} as const;

describe('ExternalWriterClient', () => {
  it('sends the validated publication request with bearer authentication', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer shared-secret-value');
      expect(JSON.parse(String(init?.body))).toEqual({
        mailbox: 'box.example.com',
        text: 'hello',
        senderId: 42,
        senderUsername: 'sender'
      });
      return Response.json({ status: 'published' });
    });
    const client = new ExternalWriterClient({
      endpoint: 'https://writer.example.test/publish',
      sharedSecret: 'shared-secret-value',
      fetcher
    });

    await expect(client.accept(request)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    [502, { error: 'publication_failed' }],
    [200, { status: 'queued' }]
  ])('fails closed on an unsuccessful writer response %#', async (status, body) => {
    const client = new ExternalWriterClient({
      endpoint: 'https://writer.example.test/publish',
      sharedSecret: 'shared-secret-value',
      fetcher: vi.fn(async () => Response.json(body, { status }))
    });

    await expect(client.accept(request)).rejects.toBeInstanceOf(ExternalWriterError);
  });
});

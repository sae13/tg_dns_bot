import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareDohTxtResolver } from '../src/adapters/cloudflare-doh-txt-resolver';

const dnsJsonHeaders = { 'content-type': 'application/dns-json' };

function dnsResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: dnsJsonHeaders });
}

afterEach(() => vi.restoreAllMocks());

describe('CloudflareDohTxtResolver', () => {
  it('uses one public credential-free exact-name TXT query and returns every direct TXT RR', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(dnsResponse({
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [
        { name: 'box.example.', type: 16, TTL: 60, data: '"first"' },
        { name: 'box.example.', type: 16, TTL: 120, data: '"second"' }
      ]
    }));
    const resolver = new CloudflareDohTxtResolver({ fetch: fetchMock });

    await expect(resolver.resolveTxt('box.example')).resolves.toEqual({
      status: 'found',
      records: [
        { name: 'box.example', ttl: 60, value: 'first' },
        { name: 'box.example', ttl: 120, value: 'second' }
      ]
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe('https://cloudflare-dns.com/dns-query');
    expect([...url.searchParams.entries()]).toEqual([['name', 'box.example'], ['type', 'TXT']]);
    expect(init).toMatchObject({ method: 'GET' });
    expect(new Headers(init?.headers).get('accept')).toBe('application/dns-json');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init).not.toHaveProperty('body');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/token|zone|secret|credential/i);
  });

  it('joins TXT character-strings in order and preserves TTL and UTF-8 escapes', async () => {
    const fetchMock = vi.fn(async () => dnsResponse({
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{
        name: 'box.example.',
        type: 16,
        TTL: 300,
        data: '"hello " "world\\033" "\\240\\159\\152\\128"'
      }]
    }));

    await expect(new CloudflareDohTxtResolver({ fetch: fetchMock }).resolveTxt('box.example'))
      .resolves.toEqual({
        status: 'found',
        records: [{ name: 'box.example', ttl: 300, value: 'hello world!😀' }]
      });
  });

  it('follows a CNAME chain contained in the same response without another lookup', async () => {
    const fetchMock = vi.fn(async () => dnsResponse({
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [
        { name: 'BOX.example.', type: 5, TTL: 60, data: 'alias.example.' },
        { name: 'alias.example.', type: 5, TTL: 60, data: 'target.example.' },
        { name: 'target.example.', type: 16, TTL: 45, data: '"via-alias"' }
      ]
    }));

    await expect(new CloudflareDohTxtResolver({ fetch: fetchMock }).resolveTxt('box.example'))
      .resolves.toEqual({
        status: 'found',
        records: [{ name: 'target.example', ttl: 45, value: 'via-alias' }]
      });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { Status: 3, Question: [{ name: 'missing.example.', type: 16 }] },
      { status: 'nxdomain' }
    ],
    [
      { Status: 0, Question: [{ name: 'empty.example.', type: 16 }] },
      { status: 'nodata' }
    ],
    [
      {
        Status: 0,
        Question: [{ name: 'alias.example.', type: 16 }],
        Answer: [{ name: 'alias.example.', type: 5, TTL: 60, data: 'target.example.' }]
      },
      { status: 'nodata' }
    ],
    [
      { Status: 2, Question: [{ name: 'broken.example.', type: 16 }] },
      { status: 'dns_error', responseCode: 2 }
    ]
  ])('maps DNS outcome %# to a typed result', async (body, expected) => {
    const question = (body.Question as { name: string }[])[0]!.name.slice(0, -1);
    const resolver = new CloudflareDohTxtResolver({ fetch: vi.fn(async () => dnsResponse(body)) });
    await expect(resolver.resolveTxt(question)).resolves.toEqual(expected);
  });

  it.each([
    ['missing question', { Status: 0, Answer: [] }],
    ['wrong question name', { Status: 0, Question: [{ name: 'other.example.', type: 16 }], Answer: [] }],
    ['wrong question type', { Status: 0, Question: [{ name: 'box.example.', type: 1 }], Answer: [] }],
    ['non-numeric DNS status', { Status: '0', Question: [{ name: 'box.example.', type: 16 }] }],
    ['unsupported answer type', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 1, TTL: 60, data: '192.0.2.1' }]
    }],
    ['unrelated TXT owner', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'other.example.', type: 16, TTL: 60, data: '"wrong"' }]
    }],
    ['CNAME loop', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [
        { name: 'box.example.', type: 5, TTL: 60, data: 'alias.example.' },
        { name: 'alias.example.', type: 5, TTL: 60, data: 'box.example.' }
      ]
    }],
    ['CNAME fork', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [
        { name: 'box.example.', type: 5, TTL: 60, data: 'one.example.' },
        { name: 'box.example.', type: 5, TTL: 60, data: 'two.example.' }
      ]
    }],
    ['negative TTL', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: -1, data: '"bad"' }]
    }],
    ['TTL above uint32', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: 4_294_967_296, data: '"bad"' }]
    }],
    ['unquoted TXT data', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: 60, data: 'bad' }]
    }],
    ['unterminated TXT segment', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: 60, data: '"bad' }]
    }],
    ['invalid escaped UTF-8', {
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: 60, data: '"\\255"' }]
    }]
  ])('classifies a malformed DoH response without leaking parser errors: %s', async (_label, body) => {
    const resolver = new CloudflareDohTxtResolver({ fetch: vi.fn(async () => dnsResponse(body)) });
    await expect(resolver.resolveTxt('box.example')).resolves.toEqual({ status: 'invalid_response' });
  });

  it.each([
    ['HTTP failure', new Response('upstream unavailable', { status: 503, headers: dnsJsonHeaders })],
    ['wrong media type', new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['invalid JSON', new Response('{', { status: 200, headers: dnsJsonHeaders })]
  ])('classifies %s as an invalid response', async (_label, response) => {
    const resolver = new CloudflareDohTxtResolver({ fetch: vi.fn(async () => response) });
    await expect(resolver.resolveTxt('box.example')).resolves.toEqual({ status: 'invalid_response' });
  });

  it('classifies a fetch rejection as a network error without leaking it', async () => {
    const resolver = new CloudflareDohTxtResolver({
      fetch: vi.fn(async () => { throw new Error('private network detail'); })
    });
    await expect(resolver.resolveTxt('box.example')).resolves.toEqual({ status: 'network_error' });
  });

  it('aborts and classifies a request that reaches its timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const resolver = new CloudflareDohTxtResolver({ fetch: fetchMock, timeoutMilliseconds: 25 });
      const resolution = resolver.resolveTxt('box.example');

      await vi.advanceTimersByTimeAsync(25);

      await expect(resolution).resolves.toEqual({ status: 'timeout' });
      expect((fetchMock.mock.calls[0]![1]?.signal as AbortSignal).aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the timeout active while reading the DoH response body', async () => {
    vi.useFakeTimers();
    try {
      let rejectBody!: (reason: unknown) => void;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: new Headers(dnsJsonHeaders),
        json: () => new Promise<unknown>((_resolve, reject) => { rejectBody = reject; })
      } as Response));
      const resolver = new CloudflareDohTxtResolver({ fetch: fetchMock, timeoutMilliseconds: 25 });
      const resolution = resolver.resolveTxt('box.example');
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(25);
      rejectBody(new DOMException('aborted', 'AbortError'));

      await expect(resolution).resolves.toEqual({ status: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a TXT character-string larger than the DNS 255-octet limit', async () => {
    const resolver = new CloudflareDohTxtResolver({ fetch: vi.fn(async () => dnsResponse({
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: 60, data: `"${'a'.repeat(256)}"` }]
    })) });

    await expect(resolver.resolveTxt('box.example')).resolves.toEqual({ status: 'invalid_response' });
  });

  it('rejects a response whose total TXT RDATA exceeds the DNS wire limit', async () => {
    const oversized = Array.from({ length: 256 }, () => `"${'a'.repeat(255)}"`).join(' ');
    const resolver = new CloudflareDohTxtResolver({ fetch: vi.fn(async () => dnsResponse({
      Status: 0,
      Question: [{ name: 'box.example.', type: 16 }],
      Answer: [{ name: 'box.example.', type: 16, TTL: 60, data: oversized }]
    })) });

    await expect(resolver.resolveTxt('box.example')).resolves.toEqual({ status: 'invalid_response' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  RecordStoreError,
  type ReplaceSingleTxtRequest
} from '../src/application/record-store';
import { CloudflareRecordStoreAdapter } from '../src/adapters/cloudflare-record-store';
import { createAllowedZoneMap } from '../src/domain/mailbox';

const API_BASE = 'https://api.test/client/v4';
const API_TOKEN = 'cloudflare-test-token-keep-secret';
const NAME = 'box.example.com';
const ZONE_ID = 'zone-1';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function request(overrides: Partial<ReplaceSingleTxtRequest> = {}): ReplaceSingleTxtRequest {
  return {
    zoneId: ZONE_ID,
    name: NAME,
    ttl: 60,
    characterStrings: ['tgdn1:abc', 'DEF_123'],
    ...overrides
  };
}

function record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'TXT', name: NAME, content: '"old"', ttl: 60, ...overrides };
}

function apiResponse(result: unknown, resultInfo?: unknown, status = 200): Response {
  return Response.json({
    success: status >= 200 && status < 300,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo })
  }, { status });
}

function listResponse(records: readonly unknown[]): Response {
  return apiResponse(records, {
    page: 1,
    per_page: 100,
    count: records.length,
    total_count: records.length,
    total_pages: 1
  });
}

function adapter(fetcher: Fetcher): CloudflareRecordStoreAdapter {
  return new CloudflareRecordStoreAdapter({
    apiToken: API_TOKEN,
    apiBaseUrl: `${API_BASE}/`,
    allowedZones: createAllowedZoneMap([['example.com', ZONE_ID], ['other.test', 'zone-2']]),
    fetcher,
    sleep: async () => undefined,
    random: () => 0,
    logger: () => undefined
  });
}

function expectCommonHeaders(init: RequestInit | undefined, mutation: boolean): void {
  const headers = new Headers(init?.headers);
  expect(headers.get('accept')).toBe('application/json');
  expect(headers.get('authorization')).toBe(`Bearer ${API_TOKEN}`);
  expect(headers.get('content-type')).toBe(mutation ? 'application/json' : null);
}

function expectSafeError(error: unknown, code: RecordStoreError['code']): void {
  expect(error).toBeInstanceOf(RecordStoreError);
  expect(error).toMatchObject({ name: 'RecordStoreError', code, message: code });
  const exposed = `${String(error)} ${JSON.stringify(error)}`;
  expect(exposed).not.toContain(API_TOKEN);
  expect(exposed).not.toContain('tgdn1:abc');
  expect(exposed).not.toContain('provider-secret-body');
}

describe('CloudflareRecordStoreAdapter', () => {
  it('appends one staged TXT without listing or replacing the existing RRset', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(apiResponse(record('stage-id', {
      name: `2.${NAME}`,
      content: '"tgdn1:abc" "DEF_123"'
    })));

    await expect(adapter(fetcher).appendSingleTxt(request({ name: `2.${NAME}` }))).resolves.toEqual({
      status: 'created', recordId: 'stage-id'
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${API_BASE}/zones/zone-1/dns_records`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'TXT', name: `2.${NAME}`, content: '"tgdn1:abc" "DEF_123"', ttl: 60
    });
  });

  it('reads and decodes every exact-name TXT RR without mutation', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(listResponse([
      record('one', { content: '"tgdn1:abc" "DEF_123"' }),
      record('two', { content: String.raw`"a\\b" "c\"d"` })
    ]));

    await expect(adapter(fetcher).readExactTxtRecords({ zoneId: ZONE_ID, name: NAME })).resolves.toEqual({
      status: 'found',
      records: [
        { recordId: 'one', wire: 'tgdn1:abcDEF_123' },
        { recordId: 'two', wire: 'a\\bc"d' }
      ]
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('pages numbered-name inventory and excludes root, nested, leading-zero, and index-one names', async () => {
    const first = [
      record('root', { name: NAME }),
      record('part-2', { name: `2.${NAME}` }),
      record('nested', { name: `x.2.${NAME}` })
    ];
    const second = [
      record('part-10', { name: `10.${NAME}` }),
      record('leading-zero', { name: `02.${NAME}` }),
      record('part-1', { name: `1.${NAME}` })
    ];
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(apiResponse(first, {
        page: 1, per_page: 100, count: first.length, total_count: 6, total_pages: 2
      }))
      .mockResolvedValueOnce(apiResponse(second, {
        page: 2, per_page: 100, count: second.length, total_count: 6, total_pages: 2
      }));

    await expect(adapter(fetcher).listNumberedTxtRecords({
      zoneId: ZONE_ID, rootName: NAME
    })).resolves.toEqual({ status: 'found', names: [`2.${NAME}`, `10.${NAME}`] });

    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `${API_BASE}/zones/zone-1/dns_records?type=TXT&name.endswith=box.example.com&page=1&per_page=100`
    );
    expect(String(fetcher.mock.calls[1]![0])).toContain('page=2');
  });

  it('deletes the complete exact-name TXT RRset through a verified batch and is idempotent when absent', async () => {
    const listed = [record('old-1'), record('old-2')];
    const deletingFetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse(listed))
      .mockResolvedValueOnce(apiResponse({ deletes: listed, patches: [], posts: [], puts: [] }));

    await expect(adapter(deletingFetcher).deleteTxtRecords({
      zoneId: ZONE_ID, name: NAME
    })).resolves.toEqual({ status: 'deleted' });
    expect(JSON.parse(String(deletingFetcher.mock.calls[1]![1]?.body))).toEqual({
      deletes: [{ id: 'old-1' }, { id: 'old-2' }]
    });

    const absentFetcher = vi.fn<Fetcher>().mockResolvedValueOnce(listResponse([]));
    await expect(adapter(absentFetcher).deleteTxtRecords({
      zoneId: ZONE_ID, name: NAME
    })).resolves.toEqual({ status: 'not_found' });
    expect(absentFetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['append', (store: CloudflareRecordStoreAdapter) => store.appendSingleTxt(request({ zoneId: 'zone-2' }))],
    ['read', (store: CloudflareRecordStoreAdapter) => store.readExactTxtRecords({ zoneId: 'zone-2', name: NAME })],
    ['inventory', (store: CloudflareRecordStoreAdapter) => store.listNumberedTxtRecords({
      zoneId: 'zone-2', rootName: NAME
    })],
    ['delete', (store: CloudflareRecordStoreAdapter) => store.deleteTxtRecords({ zoneId: 'zone-2', name: NAME })]
  ] as const)('rejects an unsafe target before fetch for the new %s operation', async (_case, invoke) => {
    const fetcher = vi.fn<Fetcher>();
    await invoke(adapter(fetcher)).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unsafe_target')
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies an append transport failure as an unknown result', async () => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValueOnce(new Error('provider-secret-body'));
    await adapter(fetcher).appendSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
  });

  it.each([
    ['unquoted content', 'legacy text'],
    ['unsupported escape', String.raw`"a\nb"`],
    ['unterminated segment', '"abc'],
    ['oversized decoded segment', `"${'a'.repeat(256)}"`]
  ] as const)('rejects malformed provider TXT content while reading: %s', async (_case, content) => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(listResponse([
      record('bad', { content })
    ]));
    await adapter(fetcher).readExactTxtRecords({ zoneId: ZONE_ID, name: NAME }).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'provider_response')
    );
  });

  it('rejects an inconsistent later inventory page instead of deriving partial cleanup debt', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(apiResponse([record('part-2', { name: `2.${NAME}` })], {
        page: 1, per_page: 100, count: 1, total_count: 2, total_pages: 2
      }))
      .mockResolvedValueOnce(apiResponse([record('part-3', { name: `3.${NAME}` })], {
        page: 2, per_page: 100, count: 1, total_count: 2, total_pages: 3
      }));
    await adapter(fetcher).listNumberedTxtRecords({ zoneId: ZONE_ID, rootName: NAME }).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'ambiguous_result')
    );
  });

  it.each([
    ['missing deletion', { deletes: [record('old-1')] }],
    ['duplicate deletion', { deletes: [record('old-1'), record('old-1')] }],
    ['unsafe deletion ID', { deletes: [record('old-1'), record('../old-2')] }]
  ] as const)('treats an unprovable delete batch as unknown: %s', async (_case, result) => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([record('old-1'), record('old-2')]))
      .mockResolvedValueOnce(apiResponse(result));
    await adapter(fetcher).deleteTxtRecords({ zoneId: ZONE_ID, name: NAME }).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
  });

  it('creates exactly one TXT record when the exact-name RRset is empty', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(apiResponse(record('created-id', {
        content: '"tgdn1:abc" "DEF_123"'
      })));

    await expect(adapter(fetcher).replaceWithSingleTxt(request())).resolves.toEqual({
      status: 'created', recordId: 'created-id'
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = fetcher.mock.calls[0]!;
    expect(String(listUrl)).toBe(
      `${API_BASE}/zones/zone-1/dns_records?type=TXT&name.exact=box.example.com&page=1&per_page=100`
    );
    expect(listInit?.method).toBe('GET');
    expect(listInit?.body).toBeUndefined();
    expectCommonHeaders(listInit, false);

    const [createUrl, createInit] = fetcher.mock.calls[1]!;
    expect(String(createUrl)).toBe(`${API_BASE}/zones/zone-1/dns_records`);
    expect(createInit?.method).toBe('POST');
    expect(JSON.parse(String(createInit?.body))).toEqual({
      type: 'TXT',
      name: NAME,
      content: '"tgdn1:abc" "DEF_123"',
      ttl: 60
    });
    expectCommonHeaders(createInit, true);
  });

  it('overwrites the one existing TXT record by provider record ID', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([record('existing-id')]))
      .mockResolvedValueOnce(apiResponse(record('existing-id', {
        content: '"tgdn1:abc" "DEF_123"', ttl: 300
      })));

    await expect(adapter(fetcher).replaceWithSingleTxt(request({ ttl: 300 }))).resolves.toEqual({
      status: 'updated', recordId: 'existing-id'
    });

    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${API_BASE}/zones/zone-1/dns_records/existing-id`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'TXT', name: NAME, content: '"tgdn1:abc" "DEF_123"', ttl: 300
    });
    expectCommonHeaders(init, true);
  });

  it('replaces multiple old or unknown TXT records with one record through the batch API', async () => {
    const oldRecords = [
      record('old-1', { content: 'legacy text' }),
      record('old-2', { content: '"unknown"' })
    ];
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse(oldRecords))
      .mockResolvedValueOnce(apiResponse({
        deletes: oldRecords,
        patches: [],
        posts: [record('replacement-id', { content: '"tgdn1:abc" "DEF_123"' })],
        puts: []
      }));

    await expect(adapter(fetcher).replaceWithSingleTxt(request())).resolves.toEqual({
      status: 'updated', recordId: 'replacement-id'
    });

    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${API_BASE}/zones/zone-1/dns_records/batch`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      deletes: [{ id: 'old-1' }, { id: 'old-2' }],
      posts: [{ type: 'TXT', name: NAME, content: '"tgdn1:abc" "DEF_123"', ttl: 60 }]
    });
    expectCommonHeaders(init, true);
  });

  it('quotes and escapes each supplied RFC 1035 character string without joining record order', async () => {
    const content = '"a\\"b" "c\\\\d"';
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(apiResponse(record('created-id', { content })));

    await adapter(fetcher).replaceWithSingleTxt(request({ characterStrings: ['a"b', 'c\\d'] }));

    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ content });
  });

  it.each([
    ['automatic TTL', request({ ttl: 1 })],
    ['Enterprise minimum TTL', request({ ttl: 30 })],
    ['maximum TTL', request({ ttl: 86_400 })],
    ['maximum character string', request({ characterStrings: ['a'.repeat(255)] })],
    ['maximum aggregate payload', request({
      characterStrings: [...Array.from({ length: 16 }, () => 'a'.repeat(255)), 'b'.repeat(16)]
    })]
  ] satisfies readonly [string, ReplaceSingleTxtRequest][])('accepts the exact provider boundary: %s', async (_case, input) => {
    const expectedContent = input.characterStrings.map((value) => `"${value}"`).join(' ');
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(apiResponse(record('created-id', {
        content: expectedContent, ttl: input.ttl
      })));

    await expect(adapter(fetcher).replaceWithSingleTxt(input)).resolves.toEqual({
      status: 'created', recordId: 'created-id'
    });
  });

  it.each<readonly [string, Partial<ReplaceSingleTxtRequest>]>([
    ['non-canonical name', { name: 'Box.Example.COM.' }],
    ['suffix lookalike', { name: 'evil-example.com' }],
    ['wrong provider zone', { zoneId: 'zone-2' }],
    ['unsafe provider zone token', { zoneId: '../zone-1' }]
  ])(
    'rejects an unsafe target before fetch: %s',
    async (_case, overrides) => {
      const fetcher = vi.fn<Fetcher>();
      await adapter(fetcher).replaceWithSingleTxt(request(overrides)).then(
        () => { throw new Error('expected rejection'); },
        (error: unknown) => expectSafeError(error, 'unsafe_target')
      );
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each<readonly [string, Partial<ReplaceSingleTxtRequest>]>([
    ['TTL below provider minimum', { ttl: 29 }],
    ['non-automatic TTL below provider minimum', { ttl: 2 }],
    ['TTL above provider maximum', { ttl: 86_401 }],
    ['fractional TTL', { ttl: 60.5 }],
    ['empty character-string list', { characterStrings: [] }],
    ['oversized character string', { characterStrings: ['a'.repeat(256)] }],
    ['oversized aggregate payload', { characterStrings: Array.from({ length: 17 }, () => 'a'.repeat(255)) }]
  ])(
    'rejects an invalid record before fetch: %s',
    async (_case, overrides) => {
      const fetcher = vi.fn<Fetcher>();
      await adapter(fetcher).replaceWithSingleTxt(request(overrides)).then(
        () => { throw new Error('expected rejection'); },
        (error: unknown) => expectSafeError(error, 'invalid_request')
      );
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it('maps a definitive list rejection to a provider error without mutation', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(
      new Response('provider-secret-body tgdn1:abc', { status: 403 })
    );

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'provider_error')
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts a complete filtered page when total_count includes unrelated zone records', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(apiResponse(
        [record('existing-id')],
        { page: 1, per_page: 100, count: 1, total_count: 500, total_pages: 1 }
      ))
      .mockResolvedValueOnce(apiResponse(record('existing-id', {
        content: '"tgdn1:abc" "DEF_123"'
      })));

    await expect(adapter(fetcher).replaceWithSingleTxt(request())).resolves.toEqual({
      status: 'updated', recordId: 'existing-id'
    });
  });

  it('rejects a paginated list rather than replacing only a partial RRset', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(apiResponse(
      [record('old-1')],
      { page: 1, per_page: 100, count: 1, total_count: 101, total_pages: 2 }
    ));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'ambiguous_result')
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong response type', [record('id-1', { type: 'A' })]],
    ['wrong response name', [record('id-1', { name: 'other.example.com' })]],
    ['unsafe response ID', [record('../id-1')]],
    ['duplicate response ID', [record('id-1'), record('id-1')]]
  ] as const)('rejects malformed or filter-violating list data: %s', async (_case, records) => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(listResponse(records));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'provider_response')
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('classifies list transport failures without retaining the thrown secret', async () => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValueOnce(
      new Error(`${API_TOKEN} provider-secret-body tgdn1:abc`)
    );

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'provider_unavailable')
    );
  });

  it('classifies a mutation transport failure as an unknown result without a cause or secret', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockRejectedValueOnce(new Error(`${API_TOKEN} provider-secret-body tgdn1:abc`));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
  });

  it('maps a definitive provider rejection to a typed provider error without response text', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response('provider-secret-body tgdn1:abc', { status: 403 }));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'provider_error')
    );
  });

  it('treats a server failure after mutation starts as an unknown result', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response('provider-secret-body tgdn1:abc', { status: 503 }));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
  });

  it.each([
    ['missing record ID', [], { type: 'TXT', name: NAME }],
    ['wrong created name', [], record('new-id', { name: 'other.example.com' })],
    ['changed updated ID', [record('old-id')], record('different-id')]
  ] as const)('treats a successful but unprovable single mutation as unknown: %s', async (_case, listed, result) => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse(listed))
      .mockResolvedValueOnce(apiResponse(result));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
  });

  it.each([
    ['missing deletion', {
      deletes: [record('old-1')],
      posts: [record('replacement-id', { content: '"tgdn1:abc" "DEF_123"' })]
    }],
    ['duplicate deletion', {
      deletes: [record('old-1'), record('old-1')],
      posts: [record('replacement-id', { content: '"tgdn1:abc" "DEF_123"' })]
    }],
    ['wrong post name', {
      deletes: [record('old-1'), record('old-2')],
      posts: [record('replacement-id', { name: 'other.example.com' })]
    }],
    ['malformed post record', {
      deletes: [record('old-1'), record('old-2')],
      posts: [record('../replacement-id')]
    }],
    ['deleted replacement ID', {
      deletes: [record('old-1'), record('old-2')],
      posts: [record('old-1')]
    }],
    ['no posted record', {
      deletes: [record('old-1'), record('old-2')],
      posts: []
    }],
    ['multiple posted records', {
      deletes: [record('old-1'), record('old-2')],
      posts: [record('replacement-1'), record('replacement-2')]
    }]
  ] as const)('treats an unprovable batch response as unknown: %s', async (_case, result) => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([record('old-1'), record('old-2')]))
      .mockResolvedValueOnce(apiResponse(result));

    await adapter(fetcher).replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
  });

  it('retries transient reads at most three times with two/four-second backoff plus deterministic jitter', async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const fetcher = vi.fn<Fetcher>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(listResponse([]));
    const store = new CloudflareRecordStoreAdapter({
      apiToken: API_TOKEN,
      apiBaseUrl: `${API_BASE}/`,
      allowedZones: createAllowedZoneMap([['example.com', ZONE_ID]]),
      fetcher,
      now: () => now,
      random: vi.fn().mockReturnValueOnce(0.25).mockReturnValueOnce(0.5),
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      logger: () => undefined
    });

    await expect(store.readExactTxtRecords({ zoneId: ZONE_ID, name: NAME })).resolves.toEqual({
      status: 'not_found'
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_500, 6_000]);
  });

  it('aborts an overlong read at the configured per-call timeout and exhausts the bounded attempts', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<Fetcher>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
      }));
      const store = new CloudflareRecordStoreAdapter({
        apiToken: API_TOKEN,
        apiBaseUrl: `${API_BASE}/`,
        allowedZones: createAllowedZoneMap([['example.com', ZONE_ID]]),
        fetcher,
        timeoutMilliseconds: 15_000,
        sleep: async () => undefined,
        random: () => 0,
        logger: () => undefined
      });

      const result = store.readExactTxtRecords({ zoneId: ZONE_ID, name: NAME });
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(result).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops before a retry delay would exceed the total operation budget', async () => {
    let now = 0;
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(new Error('network down'));
    const store = new CloudflareRecordStoreAdapter({
      apiToken: API_TOKEN,
      apiBaseUrl: `${API_BASE}/`,
      allowedZones: createAllowedZoneMap([['example.com', ZONE_ID]]),
      fetcher,
      now: () => now,
      random: () => 0,
      sleep: async (milliseconds) => { now += milliseconds; },
      budgetMilliseconds: 2_000,
      logger: () => undefined
    });

    await expect(store.readExactTxtRecords({ zoneId: ZONE_ID, name: NAME }))
      .rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not retry an ambiguous mutation transport failure before reconciliation', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockRejectedValueOnce(new Error('connection lost after send'));
    const store = adapter(fetcher);

    await store.replaceWithSingleTxt(request()).then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => expectSafeError(error, 'unknown_result')
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a rate-limited mutation without replaying the application transaction', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(apiResponse(record('created-id', {
        content: '"tgdn1:abc" "DEF_123"'
      })));

    await expect(adapter(fetcher).replaceWithSingleTxt(request())).resolves.toEqual({
      status: 'created', recordId: 'created-id'
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('emits redacted structured operation logs with correlation, duration, outcome, and error type', async () => {
    const logs: unknown[] = [];
    const store = new CloudflareRecordStoreAdapter({
      apiToken: API_TOKEN,
      apiBaseUrl: `${API_BASE}/`,
      allowedZones: createAllowedZoneMap([['example.com', ZONE_ID]]),
      fetcher: vi.fn<Fetcher>().mockResolvedValueOnce(new Response('provider-secret-body', { status: 403 })),
      correlationId: 'correlation-1',
      logger: (event) => { logs.push(event); }
    });

    await expect(store.readExactTxtRecords({ zoneId: ZONE_ID, name: NAME }))
      .rejects.toMatchObject({ code: 'provider_error' });
    expect(logs).toEqual([{
      correlationId: 'correlation-1',
      operation: 'read_exact',
      durationMilliseconds: expect.any(Number),
      outcome: 'failure',
      errorType: 'provider_error'
    }]);
    expect(JSON.stringify(logs)).not.toContain(API_TOKEN);
    expect(JSON.stringify(logs)).not.toContain('provider-secret-body');
    expect(JSON.stringify(logs)).not.toContain('tgdn1:abc');
  });

  it('does not expose the API token through adapter serialization or configuration errors', () => {
    expect(JSON.stringify(adapter(vi.fn<Fetcher>()))).not.toContain(API_TOKEN);

    expect(() => new CloudflareRecordStoreAdapter({
      apiToken: `bad token ${API_TOKEN}`,
      apiBaseUrl: API_BASE,
      allowedZones: createAllowedZoneMap([['example.com', ZONE_ID]]),
      fetcher: vi.fn<Fetcher>()
    })).toThrowError(expect.objectContaining({
      name: 'RecordStoreError', code: 'invalid_configuration', message: 'invalid_configuration'
    }));
  });
});

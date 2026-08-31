import { describe, expect, it, vi } from 'vitest';
import { reconstructInbox } from '../src/application/reconstruct-inbox';
import type { TxtResolution, TxtResolverPort } from '../src/application/txt-resolver';
import { encodeManagedMessage } from '../src/domain/managed-message-codec';
import { createManagedMessageEnvelope, type ManagedMessageEnvelope } from '../src/domain/managed-message';

const ROOT_NAME = 'box.example';
const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174000';

function envelope(text: string, overrides: Partial<ManagedMessageEnvelope> = {}): ManagedMessageEnvelope {
  return {
    ...createManagedMessageEnvelope({
      id: MESSAGE_ID,
      i: 1,
      n: 1,
      uid: 4_503_599_627_370_495,
      username: 'sender_name',
      sentAt: new Date('2026-08-30T12:15:12.345Z'),
      text
    }),
    ...overrides
  } as ManagedMessageEnvelope;
}

function resolverByName(results: Readonly<Record<string, TxtResolution>>): TxtResolverPort & {
  resolveTxt: ReturnType<typeof vi.fn>;
} {
  return {
    resolveTxt: vi.fn(async (name: string): Promise<TxtResolution> =>
      results[name] ?? { status: 'nodata' }
    )
  };
}

describe('reconstructInbox', () => {
  it('reconstructs one exact managed root while preserving unrelated TXT records', async () => {
    const root = envelope('سلام 👋');
    const resolution: TxtResolution = {
      status: 'found',
      records: [
        { name: ROOT_NAME, ttl: 120, value: 'unrelated public TXT' },
        { name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(root) }
      ]
    };
    const resolver = resolverByName({ [ROOT_NAME]: resolution });

    const result = await reconstructInbox(ROOT_NAME, resolver);

    expect(result).toEqual({
      status: 'complete',
      name: ROOT_NAME,
      message: {
        v: 1,
        id: MESSAGE_ID,
        n: 1,
        uid: 4_503_599_627_370_495,
        username: 'sender_name',
        ts: '2026-08-30T12:15:12.345Z',
        text: 'سلام 👋'
      },
      chunks: [root],
      queries: [{ name: ROOT_NAME, resolution }],
      malformed: []
    });
    expect(resolver.resolveTxt).toHaveBeenCalledOnce();
    expect(resolver.resolveTxt).toHaveBeenCalledWith(ROOT_NAME);
  });

  it('returns raw_only when no TXT record is a managed-message candidate', async () => {
    const resolution: TxtResolution = {
      status: 'found',
      records: [
        { name: ROOT_NAME, ttl: 60, value: 'v=spf1 -all' },
        { name: ROOT_NAME, ttl: 90, value: 'ordinary text' }
      ]
    };

    await expect(reconstructInbox(ROOT_NAME, resolverByName({ [ROOT_NAME]: resolution })))
      .resolves.toEqual({
        status: 'raw_only',
        name: ROOT_NAME,
        queries: [{ name: ROOT_NAME, resolution }],
        malformed: []
      });
  });

  it('queries only manifest-derived numbered names and reconstructs exact identity and chunk metadata', async () => {
    const root = envelope('first-', { i: 1, n: 3 });
    const second = envelope('second-', { i: 2, n: 3 });
    const third = envelope('third', { i: 3, n: 3 });
    const rootResolution: TxtResolution = {
      status: 'found',
      records: [
        { name: ROOT_NAME, ttl: 45, value: 'keep-root-raw' },
        { name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(root) }
      ]
    };
    const secondResolution: TxtResolution = {
      status: 'found',
      records: [
        { name: `2.${ROOT_NAME}`, ttl: 50, value: encodeManagedMessage(second) },
        { name: `2.${ROOT_NAME}`, ttl: 70, value: 'keep-second-raw' }
      ]
    };
    const thirdResolution: TxtResolution = {
      status: 'found',
      records: [{ name: `3.${ROOT_NAME}`, ttl: 80, value: encodeManagedMessage(third) }]
    };
    const resolver = resolverByName({
      [ROOT_NAME]: rootResolution,
      [`2.${ROOT_NAME}`]: secondResolution,
      [`3.${ROOT_NAME}`]: thirdResolution
    });

    const result = await reconstructInbox(ROOT_NAME, resolver);

    expect(result).toEqual({
      status: 'complete',
      name: ROOT_NAME,
      message: {
        v: 1,
        id: MESSAGE_ID,
        n: 3,
        uid: 4_503_599_627_370_495,
        username: 'sender_name',
        ts: '2026-08-30T12:15:12.345Z',
        text: 'first-second-third'
      },
      chunks: [root, second, third],
      queries: [
        { name: ROOT_NAME, resolution: rootResolution },
        { name: `2.${ROOT_NAME}`, resolution: secondResolution },
        { name: `3.${ROOT_NAME}`, resolution: thirdResolution }
      ],
      malformed: []
    });
    expect(resolver.resolveTxt.mock.calls).toEqual([
      [ROOT_NAME],
      [`2.${ROOT_NAME}`],
      [`3.${ROOT_NAME}`]
    ]);
  });

  it.each([
    ['nxdomain', { status: 'nxdomain' }],
    ['nodata', { status: 'nodata' }],
    ['dns_error', { status: 'dns_error', responseCode: 2 }],
    ['network_error', { status: 'network_error' }],
    ['timeout', { status: 'timeout' }],
    ['invalid_response', { status: 'invalid_response' }]
  ] satisfies ReadonlyArray<readonly [string, Exclude<TxtResolution, { status: 'found' }>]>) (
    'returns typed absent evidence for root resolution %s',
    async (_label, resolution) => {
      await expect(reconstructInbox(ROOT_NAME, resolverByName({ [ROOT_NAME]: resolution })))
        .resolves.toEqual({
          status: 'absent',
          name: ROOT_NAME,
          reason: resolution.status,
          queries: [{ name: ROOT_NAME, resolution }],
          malformed: []
        });
    }
  );

  it('reports multiple valid managed roots as ambiguous without querying numbered names', async () => {
    const first = envelope('first', { n: 2 });
    const second = envelope('second', {
      id: '018f47e2-8d52-7b3a-9c1e-96f82736c923',
      n: 2
    });
    const resolution: TxtResolution = {
      status: 'found',
      records: [
        { name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(first) },
        { name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(second) }
      ]
    };
    const resolver = resolverByName({ [ROOT_NAME]: resolution });

    await expect(reconstructInbox(ROOT_NAME, resolver)).resolves.toEqual({
      status: 'ambiguous',
      name: ROOT_NAME,
      roots: [first, second],
      queries: [{ name: ROOT_NAME, resolution }],
      malformed: []
    });
    expect(resolver.resolveTxt).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid_format', 'tgdnx:abc'],
    ['unsupported_version', 'tgdn2:abc'],
    ['invalid_encoding', 'tgdn1:'],
    ['invalid_utf8', 'tgdn1:_w'],
    ['invalid_json', `tgdn1:${base64Url('not-json')}`],
    ['invalid_envelope', `tgdn1:${base64Url('{}')}`],
    ['non_canonical', `tgdn1:${base64Url('{"id":"123e4567-e89b-42d3-a456-426614174000","v":1,"i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}')}`]
  ] as const)('preserves a typed malformed managed root for decode error %s', async (error, wire) => {
    const record = { name: ROOT_NAME, ttl: 60, value: wire };
    const resolution: TxtResolution = {
      status: 'found',
      records: [record, { name: ROOT_NAME, ttl: 30, value: 'unrelated' }]
    };

    await expect(reconstructInbox(ROOT_NAME, resolverByName({ [ROOT_NAME]: resolution })))
      .resolves.toEqual({
        status: 'raw_only',
        name: ROOT_NAME,
        queries: [{ name: ROOT_NAME, resolution }],
        malformed: [{ name: ROOT_NAME, record, error }]
      });
  });

  it('reports a missing numbered lookup without claiming a complete message', async () => {
    const manifest = envelope('first-', { n: 2 });
    const rootResolution: TxtResolution = {
      status: 'found',
      records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const missingResolution: TxtResolution = { status: 'nodata' };

    await expect(reconstructInbox(ROOT_NAME, resolverByName({
      [ROOT_NAME]: rootResolution,
      [`2.${ROOT_NAME}`]: missingResolution
    }))).resolves.toEqual({
      status: 'incomplete',
      name: ROOT_NAME,
      manifest,
      chunks: [manifest],
      queries: [
        { name: ROOT_NAME, resolution: rootResolution },
        { name: `2.${ROOT_NAME}`, resolution: missingResolution }
      ],
      malformed: [],
      problems: [{
        kind: 'chunk_lookup_failed',
        index: 2,
        name: `2.${ROOT_NAME}`,
        resolution: 'nodata'
      }]
    });
  });

  it('distinguishes duplicate identical chunks from conflicting chunk contents', async () => {
    const manifest = envelope('first-', { n: 2 });
    const chunk = envelope('second', { i: 2, n: 2 });
    const conflict = envelope('DIFFERENT', { i: 2, n: 2 });
    const rootResolution: TxtResolution = {
      status: 'found', records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const duplicateResolution: TxtResolution = {
      status: 'found',
      records: [
        { name: `2.${ROOT_NAME}`, ttl: 60, value: encodeManagedMessage(chunk) },
        { name: `2.${ROOT_NAME}`, ttl: 30, value: encodeManagedMessage(chunk) }
      ]
    };
    const conflictingResolution: TxtResolution = {
      status: 'found',
      records: [
        { name: `2.${ROOT_NAME}`, ttl: 60, value: encodeManagedMessage(chunk) },
        { name: `2.${ROOT_NAME}`, ttl: 30, value: encodeManagedMessage(conflict) }
      ]
    };

    const duplicate = await reconstructInbox(ROOT_NAME, resolverByName({
      [ROOT_NAME]: rootResolution, [`2.${ROOT_NAME}`]: duplicateResolution
    }));
    const conflicting = await reconstructInbox(ROOT_NAME, resolverByName({
      [ROOT_NAME]: rootResolution, [`2.${ROOT_NAME}`]: conflictingResolution
    }));

    expect(duplicate).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest, chunk, chunk],
      problems: [{ kind: 'duplicate_chunk', index: 2, name: `2.${ROOT_NAME}` }]
    });
    expect(conflicting).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest, chunk, conflict],
      problems: [{ kind: 'conflicting_chunk', index: 2, name: `2.${ROOT_NAME}` }]
    });
  });

  it.each([
    ['message id', { id: '018f47e2-8d52-7b3a-9c1e-96f82736c923' }],
    ['chunk index', { i: 1 }],
    ['chunk count', { n: 3 }],
    ['sender id', { uid: 42 }],
    ['username snapshot', { username: null }],
    ['timestamp', { ts: '2026-08-30T12:15:13.345Z' }]
  ] satisfies ReadonlyArray<readonly [string, Partial<ManagedMessageEnvelope>]>) (
    'rejects a chunk whose %s conflicts with the manifest identity',
    async (_label, overrides) => {
      const manifest = envelope('first-', { n: 2 });
      const incompatible = envelope('second', { i: 2, n: 2, ...overrides });
      const rootResolution: TxtResolution = {
        status: 'found', records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
      };
      const chunkResolution: TxtResolution = {
        status: 'found',
        records: [{ name: `2.${ROOT_NAME}`, ttl: 60, value: encodeManagedMessage(incompatible) }]
      };

      const result = await reconstructInbox(ROOT_NAME, resolverByName({
        [ROOT_NAME]: rootResolution, [`2.${ROOT_NAME}`]: chunkResolution
      }));

      expect(result).toMatchObject({
        status: 'incomplete',
        manifest,
        chunks: [manifest],
        problems: [{ kind: 'incompatible_chunk', index: 2, name: `2.${ROOT_NAME}` }]
      });
    }
  );

  it('reports a malformed numbered chunk and preserves its exact decode error and raw record', async () => {
    const manifest = envelope('first-', { n: 2 });
    const malformedRecord = { name: `2.${ROOT_NAME}`, ttl: 60, value: 'tgdn2:future' };
    const rootResolution: TxtResolution = {
      status: 'found', records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const chunkResolution: TxtResolution = { status: 'found', records: [malformedRecord] };

    const result = await reconstructInbox(ROOT_NAME, resolverByName({
      [ROOT_NAME]: rootResolution, [`2.${ROOT_NAME}`]: chunkResolution
    }));

    expect(result).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest],
      malformed: [{
        name: `2.${ROOT_NAME}`,
        record: malformedRecord,
        error: 'unsupported_version'
      }],
      problems: [{ kind: 'malformed_chunk', index: 2, name: `2.${ROOT_NAME}` }]
    });
  });

  it('does not complete a valid single-record root beside malformed or incompatible managed data', async () => {
    const manifest = envelope('complete');
    const malformedRecord = { name: ROOT_NAME, ttl: 30, value: 'tgdn2:future' };
    const incompatible = envelope('wrong-place', { i: 2, n: 2 });
    const resolution: TxtResolution = {
      status: 'found',
      records: [
        { name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) },
        malformedRecord,
        { name: ROOT_NAME, ttl: 45, value: encodeManagedMessage(incompatible) }
      ]
    };

    const result = await reconstructInbox(ROOT_NAME, resolverByName({ [ROOT_NAME]: resolution }));

    expect(result).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest],
      malformed: [{ name: ROOT_NAME, record: malformedRecord, error: 'unsupported_version' }],
      problems: [
        { kind: 'malformed_root', name: ROOT_NAME },
        { kind: 'incompatible_root', name: ROOT_NAME }
      ]
    });
  });

  it('does not complete when one valid numbered chunk has malformed and incompatible managed siblings', async () => {
    const manifest = envelope('first-', { n: 2 });
    const chunk = envelope('second', { i: 2, n: 2 });
    const incompatible = envelope('other-message', {
      id: '018f47e2-8d52-7b3a-9c1e-96f82736c923', i: 2, n: 2
    });
    const malformedRecord = { name: `2.${ROOT_NAME}`, ttl: 30, value: 'tgdn2:future' };
    const rootResolution: TxtResolution = {
      status: 'found', records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const chunkResolution: TxtResolution = {
      status: 'found',
      records: [
        { name: `2.${ROOT_NAME}`, ttl: 60, value: encodeManagedMessage(chunk) },
        malformedRecord,
        { name: `2.${ROOT_NAME}`, ttl: 45, value: encodeManagedMessage(incompatible) }
      ]
    };

    const result = await reconstructInbox(ROOT_NAME, resolverByName({
      [ROOT_NAME]: rootResolution, [`2.${ROOT_NAME}`]: chunkResolution
    }));

    expect(result).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest, chunk],
      malformed: [{
        name: `2.${ROOT_NAME}`, record: malformedRecord, error: 'unsupported_version'
      }],
      problems: [
        { kind: 'malformed_chunk', index: 2, name: `2.${ROOT_NAME}` },
        { kind: 'incompatible_chunk', index: 2, name: `2.${ROOT_NAME}` }
      ]
    });
  });

  it('bounds a forged manifest chunk count before any numbered lookup', async () => {
    const manifest = envelope('first', { n: 101 });
    const resolution: TxtResolution = {
      status: 'found', records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const resolver = resolverByName({ [ROOT_NAME]: resolution });

    const result = await reconstructInbox(ROOT_NAME, resolver);

    expect(result).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest],
      problems: [{ kind: 'chunk_count_exceeded', count: 101, maximum: 100 }]
    });
    expect(resolver.resolveTxt).toHaveBeenCalledOnce();
  });

  it('maps a thrown root resolver failure to typed absent evidence', async () => {
    const resolver: TxtResolverPort = {
      resolveTxt: vi.fn(async () => { throw new Error('private resolver detail'); })
    };

    await expect(reconstructInbox(ROOT_NAME, resolver)).resolves.toEqual({
      status: 'absent',
      name: ROOT_NAME,
      reason: 'resolver_error',
      queries: [{ name: ROOT_NAME, resolution: { status: 'resolver_error' } }],
      malformed: []
    });
  });

  it('maps a thrown numbered resolver failure to typed incomplete evidence', async () => {
    const manifest = envelope('first-', { n: 2 });
    const rootResolution: TxtResolution = {
      status: 'found', records: [{ name: ROOT_NAME, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const resolver: TxtResolverPort = {
      resolveTxt: vi.fn(async (name: string) => {
        if (name === ROOT_NAME) return rootResolution;
        throw new Error('private resolver detail');
      })
    };

    const result = await reconstructInbox(ROOT_NAME, resolver);

    expect(result).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest],
      queries: [
        { name: ROOT_NAME, resolution: rootResolution },
        { name: `2.${ROOT_NAME}`, resolution: { status: 'resolver_error' } }
      ],
      problems: [{
        kind: 'chunk_lookup_failed', index: 2, name: `2.${ROOT_NAME}`, resolution: 'resolver_error'
      }]
    });
  });

  it('rejects an invalid manifest-derived numbered name before querying it', async () => {
    const maximumRoot = [63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.');
    const manifest = envelope('first-', { n: 2 });
    const resolution: TxtResolution = {
      status: 'found', records: [{ name: maximumRoot, ttl: 60, value: encodeManagedMessage(manifest) }]
    };
    const resolver = resolverByName({ [maximumRoot]: resolution });

    const result = await reconstructInbox(maximumRoot, resolver);

    expect(result).toMatchObject({
      status: 'incomplete',
      manifest,
      chunks: [manifest],
      problems: [{ kind: 'invalid_chunk_name', index: 2, name: `2.${maximumRoot}` }]
    });
    expect(resolver.resolveTxt).toHaveBeenCalledOnce();
  });
});

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

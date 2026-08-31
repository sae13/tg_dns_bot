import { describe, expect, it, vi } from 'vitest';
import {
  RecordStoreError,
  type RecordStorePort
} from '../src/application/record-store';
import {
  PublishMessageError,
  publishMessage,
  reconcilePublicationCleanup,
  resumePublishMessage
} from '../src/application/publish-message';
import { encodeManagedMessage } from '../src/domain/managed-message-codec';
import { createManagedMessageEnvelope } from '../src/domain/managed-message';
import { createPublishPlan } from '../src/domain/publish-plan';

const ROOT_NAME = 'box.example.com';
const ZONE_ID = 'zone-1';
const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174000';

function multiRecordPlan() {
  return createPublishPlan(ROOT_NAME, createManagedMessageEnvelope({
    id: MESSAGE_ID,
    i: 1,
    n: 1,
    uid: 42,
    username: 'sender',
    sentAt: new Date('2026-08-30T12:15:12.345Z'),
    text: 'پیام بلند 😀 '.repeat(1_000)
  }));
}

describe('publishMessage', () => {
  it('publishes a single-record plan with root as its only mutation and no numbered cleanup', async () => {
    const source = createManagedMessageEnvelope({
      id: MESSAGE_ID,
      i: 1,
      n: 1,
      uid: 42,
      sentAt: new Date('2026-08-30T12:15:12.345Z'),
      text: 'کوتاه'
    });
    const plan = createPublishPlan(ROOT_NAME, source);
    const store = {
      appendSingleTxt: vi.fn(),
      replaceWithSingleTxt: vi.fn(async () => ({ status: 'updated', recordId: 'root-id' }) as const),
      listNumberedTxtRecords: vi.fn(async () => ({ status: 'not_found' }) as const),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan })).resolves.toEqual({
      status: 'committed', messageId: MESSAGE_ID
    });
    expect(store.appendSingleTxt).not.toHaveBeenCalled();
    expect(store.replaceWithSingleTxt).toHaveBeenCalledExactlyOnceWith({
      zoneId: ZONE_ID,
      name: ROOT_NAME,
      ttl: 60,
      characterStrings: plan.records[0]!.characterStrings
    });
  });

  it.each([
    ['out-of-order records', (plan: ReturnType<typeof multiRecordPlan>) => ({
      ...plan,
      records: [...plan.records].reverse()
    })],
    ['inconsistent part metadata', (plan: ReturnType<typeof multiRecordPlan>) => {
      const part = plan.records[1]!;
      const wire = encodeManagedMessage(createManagedMessageEnvelope({
        id: part.envelope.id,
        i: part.envelope.i,
        n: part.envelope.n,
        uid: part.envelope.uid + 1,
        username: part.envelope.username,
        sentAt: new Date(part.envelope.ts),
        text: part.envelope.text
      }));
      return {
        ...plan,
        records: [
          plan.records[0]!,
          { ...part, wire, characterStrings: [wire] },
          ...plan.records.slice(2)
        ]
      };
    }]
  ] as const)('rejects a malformed plan before any side effect: %s', async (_case, corrupt) => {
    const malformed = corrupt(multiRecordPlan());
    const store = {
      appendSingleTxt: vi.fn(),
      replaceWithSingleTxt: vi.fn(),
      listNumberedTxtRecords: vi.fn(),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, {
      zoneId: ZONE_ID,
      ttl: 60,
      plan: malformed
    })).rejects.toEqual(expect.objectContaining<Partial<PublishMessageError>>({
      name: 'PublishMessageError', code: 'invalid_plan', message: 'invalid_plan'
    }));
    expect(store.appendSingleTxt).not.toHaveBeenCalled();
    expect(store.replaceWithSingleTxt).not.toHaveBeenCalled();
  });

  it('stages every numbered part before committing root and only then collapses staged RRsets', async () => {
    const plan = multiRecordPlan();
    expect(plan.records.length).toBeGreaterThan(2);
    const events: string[] = [];
    const store = {
      appendSingleTxt: vi.fn(async ({ name }) => {
        events.push(`append:${name}`);
        return { status: 'created', recordId: `new-${name}` } as const;
      }),
      replaceWithSingleTxt: vi.fn(async ({ name }) => {
        events.push(`replace:${name}`);
        return { status: 'updated', recordId: `one-${name}` } as const;
      }),
      listNumberedTxtRecords: vi.fn(async () => {
        events.push('inventory');
        return { status: 'found', names: [] } as const;
      }),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan })).resolves.toEqual({
      status: 'committed',
      messageId: MESSAGE_ID
    });

    expect(events).toEqual([
      ...plan.records.slice(1).map((record) => `append:${record.name}`),
      `replace:${ROOT_NAME}`,
      ...plan.records.slice(1).map((record) => `replace:${record.name}`),
      'inventory'
    ]);
  });

  it.each(
    Array.from({ length: multiRecordPlan().records.length - 1 }, (_, index) => index + 1)
  )('does not attempt root commit when numbered stage %i fails', async (failurePoint) => {
    const plan = multiRecordPlan();
    const calls: string[] = [];
    const store = {
      appendSingleTxt: vi.fn(async ({ name }) => {
        calls.push(`append:${name}`);
        if (calls.length === failurePoint) throw new RecordStoreError('provider_unavailable');
        return { status: 'created', recordId: `new-${name}` } as const;
      }),
      replaceWithSingleTxt: vi.fn(),
      listNumberedTxtRecords: vi.fn(),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan })).resolves.toEqual({
      status: 'not_committed',
      messageId: MESSAGE_ID,
      failure: { operation: 'stage', code: 'provider_unavailable' }
    });
    expect(store.replaceWithSingleTxt).not.toHaveBeenCalled();
  });

  it.each([
    ['definitive', 'provider_error', 'not_committed'],
    ['unknown', 'unknown_result', 'commit_unknown']
  ] as const)('returns a typed %s commit failure without starting cleanup', async (_case, code, status) => {
    const plan = multiRecordPlan();
    const store = {
      appendSingleTxt: vi.fn(async () => ({ status: 'created', recordId: 'stage-id' }) as const),
      replaceWithSingleTxt: vi.fn(async ({ name }) => {
        if (name === ROOT_NAME) throw new RecordStoreError(code);
        return { status: 'updated', recordId: 'cleanup-id' } as const;
      }),
      listNumberedTxtRecords: vi.fn(),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    const result = await publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan });

    expect(result).toEqual({
      status,
      messageId: MESSAGE_ID,
      failure: { operation: 'commit', code }
    });
    expect(store.listNumberedTxtRecords).not.toHaveBeenCalled();
    expect(store.replaceWithSingleTxt).toHaveBeenCalledTimes(1);
  });

  it('reconciles a committed root after an ambiguous response without mutating root twice', async () => {
    const plan = multiRecordPlan();
    const store = {
      appendSingleTxt: vi.fn(async () => ({ status: 'created', recordId: 'stage-id' }) as const),
      replaceWithSingleTxt: vi.fn(async ({ name }) => {
        if (name === ROOT_NAME) throw new RecordStoreError('unknown_result');
        return { status: 'updated', recordId: `one-${name}` } as const;
      }),
      readExactTxtRecords: vi.fn(async ({ name }) => name === ROOT_NAME
        ? { status: 'found', records: [{ recordId: 'root', wire: plan.records[0]!.wire }] } as const
        : { status: 'not_found' } as const),
      listNumberedTxtRecords: vi.fn(async () => ({
        status: 'found', names: plan.records.slice(1).map(({ name }) => name)
      }) as const),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan })).resolves.toEqual({
      status: 'committed', messageId: MESSAGE_ID
    });
    expect(store.replaceWithSingleTxt.mock.calls.filter(([value]) => value.name === ROOT_NAME)).toHaveLength(1);
    expect(store.readExactTxtRecords).toHaveBeenCalledExactlyOnceWith({
      zoneId: ZONE_ID, name: ROOT_NAME
    });
  });

  it('reconciles an ambiguously appended numbered part and does not append it twice', async () => {
    const plan = multiRecordPlan();
    const ambiguousPart = plan.records[1]!;
    const store = {
      appendSingleTxt: vi.fn(async ({ name }) => {
        if (name === ambiguousPart.name) throw new RecordStoreError('unknown_result');
        return { status: 'created', recordId: `stage-${name}` } as const;
      }),
      replaceWithSingleTxt: vi.fn(async ({ name }) => ({
        status: 'updated', recordId: `one-${name}`
      }) as const),
      readExactTxtRecords: vi.fn(async ({ name }) => name === ambiguousPart.name
        ? { status: 'found', records: [{ recordId: 'ambiguous-stage', wire: ambiguousPart.wire }] } as const
        : { status: 'not_found' } as const),
      listNumberedTxtRecords: vi.fn(async () => ({ status: 'not_found' }) as const),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan })).resolves.toEqual({
      status: 'committed', messageId: MESSAGE_ID
    });
    expect(store.appendSingleTxt.mock.calls.filter(([value]) => value.name === ambiguousPart.name)).toHaveLength(1);
  });

  it('resumes an unknown stage by reconciling each part before the only allowed continuation append', async () => {
    const plan = multiRecordPlan();
    const firstPart = plan.records[1]!;
    const store = {
      appendSingleTxt: vi.fn(async ({ name }) => ({
        status: 'created', recordId: `stage-${name}`
      }) as const),
      replaceWithSingleTxt: vi.fn(async ({ name }) => ({
        status: 'updated', recordId: `one-${name}`
      }) as const),
      readExactTxtRecords: vi.fn(async ({ name }) => name === firstPart.name
        ? { status: 'found', records: [{ recordId: 'already-committed', wire: firstPart.wire }] } as const
        : { status: 'not_found' } as const),
      listNumberedTxtRecords: vi.fn(async () => ({ status: 'not_found' }) as const),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(resumePublishMessage(store, {
      zoneId: ZONE_ID,
      ttl: 60,
      plan,
      publicationStatus: 'not_committed',
      failureOperation: 'stage'
    })).resolves.toEqual({ status: 'committed', messageId: MESSAGE_ID });
    expect(store.appendSingleTxt).not.toHaveBeenCalledWith(expect.objectContaining({ name: firstPart.name }));
    expect(store.appendSingleTxt).toHaveBeenCalledTimes(plan.records.length - 2);
  });

  it('resumes an unknown commit by reconciling before the only allowed continuation mutation', async () => {
    const plan = multiRecordPlan();
    const store = {
      appendSingleTxt: vi.fn(),
      replaceWithSingleTxt: vi.fn(async ({ name }) => ({
        status: 'updated', recordId: `one-${name}`
      }) as const),
      readExactTxtRecords: vi.fn(async ({ name }) => name === ROOT_NAME
        ? { status: 'not_found' } as const
        : { status: 'found', records: [{
            recordId: `stage-${name}`,
            wire: plan.records.find((record) => record.name === name)!.wire
          }] } as const),
      listNumberedTxtRecords: vi.fn(async () => ({ status: 'not_found' }) as const),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(resumePublishMessage(store, {
      zoneId: ZONE_ID,
      ttl: 60,
      plan,
      publicationStatus: 'commit_unknown'
    })).resolves.toEqual({ status: 'committed', messageId: MESSAGE_ID });
    expect(store.appendSingleTxt).not.toHaveBeenCalled();
    expect(store.replaceWithSingleTxt.mock.calls.filter(([value]) => value.name === ROOT_NAME)).toHaveLength(1);
  });

  it('keeps a successful commit while collecting independent replace, inventory, and delete failures', async () => {
    const plan = multiRecordPlan();
    const firstNumbered = plan.records[1]!;
    const staleName = `${plan.records.length + 1}.${ROOT_NAME}`;
    const store = {
      appendSingleTxt: vi.fn(async () => ({ status: 'created', recordId: 'stage-id' }) as const),
      replaceWithSingleTxt: vi.fn(async ({ name }) => {
        if (name === firstNumbered.name) throw new RecordStoreError('provider_unavailable');
        return { status: 'updated', recordId: `one-${name}` } as const;
      }),
      listNumberedTxtRecords: vi.fn(async () => ({
        status: 'found', names: [firstNumbered.name, staleName]
      }) as const),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn(async () => { throw new RecordStoreError('unknown_result'); })
    } satisfies RecordStorePort;

    const result = await publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan });

    expect(result).toEqual({
      status: 'committed_cleanup_pending',
      messageId: MESSAGE_ID,
      failures: [
        { operation: 'cleanup_replace', code: 'provider_unavailable' },
        { operation: 'cleanup_delete', code: 'unknown_result' }
      ]
    });
    expect(store.replaceWithSingleTxt).toHaveBeenCalledTimes(plan.records.length);
    expect(store.deleteTxtRecords).toHaveBeenCalledWith({ zoneId: ZONE_ID, name: staleName });
  });

  it('reports an inventory failure after commit without invalidating the committed message', async () => {
    const plan = multiRecordPlan();
    const store = {
      appendSingleTxt: vi.fn(async () => ({ status: 'created', recordId: 'stage-id' }) as const),
      replaceWithSingleTxt: vi.fn(async () => ({ status: 'updated', recordId: 'record-id' }) as const),
      listNumberedTxtRecords: vi.fn(async () => { throw new RecordStoreError('provider_unavailable'); }),
      readExactTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(publishMessage(store, { zoneId: ZONE_ID, ttl: 60, plan })).resolves.toEqual({
      status: 'committed_cleanup_pending',
      messageId: MESSAGE_ID,
      failures: [{ operation: 'cleanup_inventory', code: 'provider_unavailable' }]
    });
    expect(store.deleteTxtRecords).not.toHaveBeenCalled();
  });

  it('derives restart cleanup from the current root and inventory without local queue state', async () => {
    const plan = multiRecordPlan();
    const staleName = `${plan.records.length + 1}.${ROOT_NAME}`;
    const store = {
      appendSingleTxt: vi.fn(),
      replaceWithSingleTxt: vi.fn(async () => ({ status: 'updated', recordId: 'collapsed' }) as const),
      readExactTxtRecords: vi.fn(async ({ name }) => {
        const record = plan.records.find((candidate) => candidate.name === name);
        return record === undefined
          ? { status: 'not_found' } as const
          : { status: 'found', records: [{ recordId: `id-${name}`, wire: record.wire }] } as const;
      }),
      listNumberedTxtRecords: vi.fn(async () => ({
        status: 'found', names: [...plan.records.slice(1).map(({ name }) => name), staleName]
      }) as const),
      deleteTxtRecords: vi.fn(async () => ({ status: 'deleted' }) as const)
    } satisfies RecordStorePort;

    await expect(reconcilePublicationCleanup(store, {
      zoneId: ZONE_ID,
      rootName: ROOT_NAME,
      ttl: 60
    })).resolves.toEqual({ status: 'reconciled', messageId: MESSAGE_ID });

    expect(store.replaceWithSingleTxt).toHaveBeenCalledTimes(plan.records.length - 1);
    expect(store.deleteTxtRecords).toHaveBeenCalledExactlyOnceWith({ zoneId: ZONE_ID, name: staleName });
  });

  it('does not reconcile from duplicate managed root records even when their wires are identical', async () => {
    const plan = multiRecordPlan();
    const store = {
      appendSingleTxt: vi.fn(),
      replaceWithSingleTxt: vi.fn(),
      readExactTxtRecords: vi.fn(async () => ({
        status: 'found',
        records: [
          { recordId: 'root-1', wire: plan.records[0]!.wire },
          { recordId: 'root-2', wire: plan.records[0]!.wire }
        ]
      }) as const),
      listNumberedTxtRecords: vi.fn(),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(reconcilePublicationCleanup(store, {
      zoneId: ZONE_ID,
      rootName: ROOT_NAME,
      ttl: 60
    })).resolves.toEqual({
      status: 'cleanup_pending',
      messageId: null,
      failures: [{ operation: 'cleanup_root', code: 'ambiguous_result' }]
    });
    expect(store.listNumberedTxtRecords).not.toHaveBeenCalled();
    expect(store.replaceWithSingleTxt).not.toHaveBeenCalled();
  });

  it('leaves ambiguous numbered data untouched and reports cleanup debt', async () => {
    const plan = multiRecordPlan();
    const numbered = plan.records[1]!;
    const conflictingWire = encodeManagedMessage(createManagedMessageEnvelope({
      id: MESSAGE_ID,
      i: numbered.envelope.i,
      n: numbered.envelope.n,
      uid: numbered.envelope.uid,
      username: numbered.envelope.username,
      sentAt: new Date(numbered.envelope.ts),
      text: `${numbered.envelope.text}متفاوت`
    }));
    const store = {
      appendSingleTxt: vi.fn(),
      replaceWithSingleTxt: vi.fn(),
      readExactTxtRecords: vi.fn(async ({ name }) => {
        if (name === ROOT_NAME) {
          return { status: 'found', records: [{ recordId: 'root', wire: plan.records[0]!.wire }] } as const;
        }
        if (name === numbered.name) {
          return {
            status: 'found',
            records: [
              { recordId: 'current', wire: numbered.wire },
              { recordId: 'conflicting', wire: conflictingWire }
            ]
          } as const;
        }
        const record = plan.records.find((candidate) => candidate.name === name);
        return record === undefined
          ? { status: 'not_found' } as const
          : { status: 'found', records: [{ recordId: `id-${name}`, wire: record.wire }] } as const;
      }),
      listNumberedTxtRecords: vi.fn(async () => ({ status: 'found', names: [numbered.name] }) as const),
      deleteTxtRecords: vi.fn()
    } satisfies RecordStorePort;

    await expect(reconcilePublicationCleanup(store, {
      zoneId: ZONE_ID,
      rootName: ROOT_NAME,
      ttl: 60
    })).resolves.toEqual({
      status: 'cleanup_pending',
      messageId: MESSAGE_ID,
      failures: [{ operation: 'cleanup_read', code: 'ambiguous_result' }]
    });
    expect(store.replaceWithSingleTxt).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: numbered.name })
    );
    expect(store.deleteTxtRecords).not.toHaveBeenCalled();
  });
});

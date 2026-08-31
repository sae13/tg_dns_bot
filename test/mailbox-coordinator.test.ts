import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { SendRequest } from '../src/application/handle-update';
import type { Env } from '../src/config';
import {
  MailboxCoordinator,
  type MailboxPublisher
} from '../src/durable-objects/mailbox-coordinator';

const workerEnv = env as Env;
let nextObject = 0;

function request(updateId: number, mailbox = 'box.example.com', senderId = 42): SendRequest {
  return {
    updateId,
    mailbox,
    zoneId: 'zone-1',
    text: `message-${updateId}`,
    senderId,
    senderUsername: `user${senderId}`
  };
}

function stub(mailbox = `box-${nextObject += 1}.example.com`): DurableObjectStub {
  const namespace = workerEnv.COORDINATOR;
  if (namespace === undefined) throw new Error('missing test coordinator binding');
  return namespace.get(namespace.idFromName(mailbox));
}

function runCoordinator<R>(
  object: DurableObjectStub,
  callback: (instance: MailboxCoordinator, state: DurableObjectState) => R | Promise<R>
): Promise<R> {
  return runInDurableObject(object, (instance, state) =>
    callback(instance as MailboxCoordinator, state)
  );
}

const committed: MailboxPublisher = async ({ updateId }) => ({
  status: 'committed',
  messageId: `00000000-0000-4000-8000-${String(updateId).padStart(12, '0')}`
});

describe('MailboxCoordinator Durable Object', () => {
  it('assigns increasing sequences and serializes same-mailbox publication in FIFO order', async () => {
    const object = stub();
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });

    const results = await runCoordinator(object, async (instance) => {
      const publisher: MailboxPublisher = async (input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(`start:${input.updateId}`);
        if (input.updateId === 1) {
          firstStarted();
          await gate;
        }
        events.push(`commit:${input.updateId}`);
        active -= 1;
        return committed(input, 0, 0, crypto.randomUUID());
      };

      const first = instance.coordinate(request(1), publisher, 1_000);
      await started;
      const second = instance.coordinate(request(2), publisher, 1_001);
      releaseFirst();
      return Promise.all([first, second]);
    });

    expect(results).toEqual([
      { status: 'published', sequence: 1, publicationStatus: 'committed' },
      { status: 'published', sequence: 2, publicationStatus: 'committed' }
    ]);
    expect(maximumActive).toBe(1);
    expect(events).toEqual(['start:1', 'commit:1', 'start:2', 'commit:2']);
  });

  it('does not let a blocked mailbox delay a different mailbox object', async () => {
    const firstObject = stub('first.example.com');
    const secondObject = stub('second.example.com');
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const progressed = new Promise<void>((resolve) => { secondStarted = resolve; });

    const first = runCoordinator(firstObject, (instance) => instance.coordinate(
      request(11, 'first.example.com'),
      async (input, sequence, acceptedAt) => {
        firstStarted();
        await gate;
        return committed(input, sequence, acceptedAt, crypto.randomUUID());
      },
      2_000
    ));
    await started;
    const second = runCoordinator(secondObject, (instance) => instance.coordinate(
      request(12, 'second.example.com'),
      async (input, sequence, acceptedAt) => {
        secondStarted();
        return committed(input, sequence, acceptedAt, crypto.randomUUID());
      },
      2_000
    ));

    await progressed;
    await expect(second).resolves.toEqual({
      status: 'published', sequence: 1, publicationStatus: 'committed'
    });
    releaseFirst();
    await expect(first).resolves.toEqual({
      status: 'published', sequence: 1, publicationStatus: 'committed'
    });
  });

  it('deduplicates the same update while its first publication is still pending', async () => {
    const object = stub();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const publishing = new Promise<void>((resolve) => { started = resolve; });
    const publisher: MailboxPublisher = async (input) => {
      started();
      await gate;
      return committed(input, 0, 0, crypto.randomUUID());
    };

    const results = await runCoordinator(object, async (instance) => {
      const first = instance.coordinate(request(20), publisher, 2_900);
      await publishing;
      const duplicate = instance.coordinate(request(20), publisher, 2_901);
      release();
      return Promise.all([first, duplicate]);
    });
    expect(results).toEqual([
      { status: 'published', sequence: 1, publicationStatus: 'committed' },
      { status: 'duplicate', sequence: 1 }
    ]);
  });

  it('persists successful update_id deduplication when a fresh instance is created over the same storage', async () => {
    const object = stub();
    const publisher = vi.fn(committed);

    await expect(runCoordinator(object, (instance) =>
      instance.coordinate(request(21), publisher, 3_000)
    )).resolves.toEqual({ status: 'published', sequence: 1, publicationStatus: 'committed' });

    await expect(runCoordinator(object, (_instance, state) => {
      const restarted = new MailboxCoordinator(state, workerEnv);
      return restarted.coordinate(request(21), publisher, 3_001);
    })).resolves.toEqual({ status: 'duplicate', sequence: 1 });
    expect(publisher).toHaveBeenCalledOnce();
  });

  it('rejects a changed payload that reuses a pending update_id', async () => {
    const object = stub();
    const failed: MailboxPublisher = async (_request, _sequence, _acceptedAt, messageId) => ({
      status: 'not_committed',
      messageId,
      failure: { operation: 'commit', code: 'provider_error' }
    });
    await runCoordinator(object, (instance) =>
      instance.coordinate(request(29), failed, 3_800)
    );

    await expect(runCoordinator(object, (instance) =>
      instance.coordinate({ ...request(29), text: 'tampered' }, committed, 3_801)
    )).rejects.toThrow('update_id_conflict');
  });

  it.each(['not_committed', 'commit_unknown'] as const)(
    'keeps a typed %s publication retryable with the same admission and message id',
    async (publicationStatus) => {
      const object = stub();
      const messageIds: string[] = [];
      const failed: MailboxPublisher = async (_request, _sequence, _acceptedAt, messageId) => {
        messageIds.push(messageId);
        return {
          status: publicationStatus,
          messageId,
          failure: { operation: 'commit', code: 'unknown_result' }
        };
      };

      await expect(runCoordinator(object, (instance) =>
        instance.coordinate(request(30), failed, 3_900)
      )).resolves.toEqual({
        status: 'publication_failed', sequence: 1, publicationStatus
      });

      await expect(runCoordinator(object, (instance) =>
        instance.coordinate(request(30), async (input, sequence, acceptedAt, messageId) => {
          messageIds.push(messageId);
          return committed(input, sequence, acceptedAt, messageId);
        }, 3_901)
      )).resolves.toEqual({ status: 'published', sequence: 1, publicationStatus: 'committed' });
      expect(messageIds[0]).toBe(messageIds[1]);
    }
  );

  it('persists ambiguous work and schedules an alarm that survives a fresh instance', async () => {
    const object = stub();
    const now = Date.now() + 60_000;
    const ambiguous: MailboxPublisher = async (_input, _sequence, _acceptedAt, messageId) => ({
      status: 'commit_unknown',
      messageId,
      failure: { operation: 'commit', code: 'unknown_result' }
    });

    const durable = await runCoordinator(object, async (instance, state) => {
      const result = await instance.coordinate(request(32), ambiguous, now);
      const pending = await state.storage.get('pending-update:32');
      const alarm = await state.storage.getAlarm();
      const restarted = new MailboxCoordinator(state, workerEnv, ambiguous);
      return { result, pending, alarm, restarted };
    });
    expect(durable.result).toEqual({
      status: 'publication_failed', sequence: 1, publicationStatus: 'commit_unknown'
    });
    expect(durable.pending).toMatchObject({ sequence: 1, messageId: expect.any(String) });
    expect(durable.alarm).toBeGreaterThanOrEqual(now + 2_000);
    expect(durable.restarted).toBeInstanceOf(MailboxCoordinator);
  });

  it('alarm completes durable pending work without a second admission or message id', async () => {
    const object = stub();
    const messageIds: string[] = [];
    const ambiguous: MailboxPublisher = async (_input, _sequence, _acceptedAt, messageId) => {
      messageIds.push(messageId);
      return {
        status: 'commit_unknown',
        messageId,
        failure: { operation: 'commit', code: 'unknown_result' }
      };
    };
    const durable = await runCoordinator(object, async (instance, state) => {
      await instance.coordinate(request(33), ambiguous, 6_000);
      const restarted = new MailboxCoordinator(state, workerEnv, async (input, sequence, acceptedAt, messageId) => {
        messageIds.push(messageId);
        return committed(input, sequence, acceptedAt, messageId);
      });
      await restarted.alarm();
      return {
        pending: await state.storage.get('pending-update:33'),
        processed: await state.storage.get('processed-update:33'),
        sender: await state.storage.get<readonly number[]>('rate:sender:42')
      };
    });
    expect(durable).toMatchObject({
      pending: undefined,
      processed: { sequence: 1 },
      sender: [6_000]
    });
    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toBe(messageIds[1]);
  });

  it('does not schedule durable retry for a terminal provider rejection', async () => {
    const object = stub();
    const terminal: MailboxPublisher = async (_input, _sequence, _acceptedAt, messageId) => ({
      status: 'not_committed',
      messageId,
      failure: { operation: 'commit', code: 'provider_error' }
    });
    const result = await runCoordinator(object, async (instance, state) => {
      const publication = await instance.coordinate(request(34), terminal, Date.now() + 60_000);
      return { publication, alarm: await state.storage.getAlarm() };
    });
    expect(result.publication).toEqual({
      status: 'publication_failed', sequence: 1, publicationStatus: 'not_committed'
    });
    expect(result.alarm).toBeNull();
  });

  it('keeps thrown publication failures retryable without charging their admission twice', async () => {
    const object = stub();
    const messageIds: string[] = [];
    const failing: MailboxPublisher = async (_request, _sequence, _acceptedAt, messageId) => {
      messageIds.push(messageId);
      throw new Error('publish failed');
    };
    const retrying: MailboxPublisher = async (input, sequence, acceptedAt, messageId) => {
      messageIds.push(messageId);
      return committed(input, sequence, acceptedAt, messageId);
    };

    await expect(runCoordinator(object, (instance) =>
      instance.coordinate(request(31), failing, 4_000)
    )).rejects.toThrow('publish failed');

    await expect(runCoordinator(object, (instance) =>
      instance.coordinate(request(31), retrying, 4_001)
    )).resolves.toEqual({ status: 'published', sequence: 1, publicationStatus: 'committed' });
    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toBe(messageIds[1]);

    const state = await runCoordinator(object, async (_instance, durableState) => ({
      sender: await durableState.storage.get<readonly number[]>('rate:sender:42'),
      mailbox: await durableState.storage.get<readonly number[]>('rate:mailbox'),
      pending: await durableState.storage.get('pending-update:31')
    }));
    expect(state).toEqual({ sender: [4_000], mailbox: [4_000], pending: undefined });
  });

  it('atomically rejects a full sender bucket without charging the mailbox bucket', async () => {
    const object = stub();
    await runCoordinator(object, async (instance, state) => {
      await state.storage.put({
        'rate:sender:1': [10_000, 10_001, 10_002, 10_003, 10_004],
        'rate:mailbox': [10_000]
      });
      const result = await instance.coordinate(request(41, 'box.example.com', 1), committed, 10_005);
      expect(result).toEqual({ status: 'rate_limited', limitedBy: 'sender', retryAfterSeconds: 60 });
    });

    const mailbox = await runCoordinator(object, async (_instance, state) =>
      state.storage.get<readonly number[]>('rate:mailbox')
    );
    expect(mailbox).toEqual([10_000]);
  });

  it('atomically rejects a full mailbox bucket without charging the sender bucket', async () => {
    const object = stub();
    await runCoordinator(object, async (instance, state) => {
      await state.storage.put({
        'rate:sender:2': [10_000],
        'rate:mailbox': [10_000, 10_001, 10_002]
      });
      const result = await instance.coordinate(request(42, 'box.example.com', 2), committed, 10_003);
      expect(result).toEqual({ status: 'rate_limited', limitedBy: 'mailbox', retryAfterSeconds: 60 });
    });

    const sender = await runCoordinator(object, async (_instance, state) =>
      state.storage.get<readonly number[]>('rate:sender:2')
    );
    expect(sender).toEqual([10_000]);
  });

  it('uses the configured sender and mailbox capacities for normal admissions', async () => {
    const object = stub();
    const results = await runCoordinator(object, async (instance) => [
      await instance.coordinate(request(43, 'box.example.com', 1), committed, 11_000),
      await instance.coordinate(request(44, 'box.example.com', 1), committed, 11_001),
      await instance.coordinate(request(45, 'box.example.com', 2), committed, 11_002),
      await instance.coordinate(request(46, 'box.example.com', 3), committed, 11_003)
    ]);
    expect(results).toEqual([
      { status: 'published', sequence: 1, publicationStatus: 'committed' },
      { status: 'published', sequence: 2, publicationStatus: 'committed' },
      { status: 'published', sequence: 3, publicationStatus: 'committed' },
      { status: 'rate_limited', limitedBy: 'mailbox', retryAfterSeconds: 60 }
    ]);
  });

  it('does not move the stored limiter clock backwards', async () => {
    const object = stub();
    await runCoordinator(object, async (instance) => {
      await instance.coordinate(request(55), committed, 200_000);
      await instance.coordinate(request(56), committed, 100_000);
    });
    const clock = await runCoordinator(object, async (_instance, state) =>
      state.storage.get<number>('monotonic-clock')
    );
    expect(clock).toBe(200_000);
  });

  it('reopens the sliding window and deletes sender buckets idle for two windows', async () => {
    const object = stub();
    await runCoordinator(object, async (instance) => {
      await instance.coordinate(request(51, 'box.example.com', 1), committed, 20_000);
      await instance.coordinate(request(52, 'box.example.com', 2), committed, 20_001);
      await instance.coordinate(request(53, 'box.example.com', 3), committed, 20_002);
    });

    const result = await runCoordinator(object, (instance) =>
      instance.coordinate(request(54, 'box.example.com', 4), committed, 140_003)
    );
    expect(result).toEqual({ status: 'published', sequence: 4, publicationStatus: 'committed' });

    const senderKeys = await runCoordinator(object, async (_instance, state) =>
      [...(await state.storage.list({ prefix: 'rate:sender:' })).keys()]
    );
    expect(senderKeys).toEqual(['rate:sender:4']);
  });
});

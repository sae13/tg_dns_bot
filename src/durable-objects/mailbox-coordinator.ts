import type { SendRequest } from '../application/handle-update';
import {
  publishMessage,
  resumePublishMessage,
  type PublishMessageResult
} from '../application/publish-message';
import { CloudflareRecordStoreAdapter } from '../adapters/cloudflare-record-store';
import { coordinatorPublishConfig, type Env } from '../config';
import { createManagedMessageEnvelope } from '../domain/managed-message';
import { createPublishPlan } from '../domain/publish-plan';

const NEXT_SEQUENCE_KEY = 'next-sequence';
const CLOCK_KEY = 'monotonic-clock';
const MAILBOX_RATE_KEY = 'rate:mailbox';
const SENDER_RATE_PREFIX = 'rate:sender:';
const PROCESSED_UPDATE_PREFIX = 'processed-update:';
const PENDING_UPDATE_PREFIX = 'pending-update:';
const RETRY_DELAY_MILLISECONDS = 2_000;

export type MailboxPublisher = (
  request: SendRequest,
  sequence: number,
  acceptedAt: number,
  messageId: string
) => Promise<PublishMessageResult>;

export type CoordinationResult =
  | { readonly status: 'duplicate'; readonly sequence: number }
  | {
      readonly status: 'rate_limited';
      readonly limitedBy: 'sender' | 'mailbox';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly status: 'published' | 'publication_failed';
      readonly sequence: number;
      readonly publicationStatus: PublishMessageResult['status'];
    };

interface ProcessedUpdate {
  readonly sequence: number;
  readonly processedAt: number;
}

interface PendingUpdate {
  readonly sequence: number;
  readonly acceptedAt: number;
  readonly messageId: string;
  readonly request: SendRequest;
  readonly publicationStatus?: PublishMessageResult['status'];
  readonly failureOperation?: 'stage' | 'commit' | undefined;
}

interface RateConfig {
  readonly senderCapacity: number;
  readonly mailboxCapacity: number;
  readonly windowMilliseconds: number;
}

interface AdmissionAccepted {
  readonly status: 'accepted';
  readonly sequence: number;
  readonly senderTimestamps: readonly number[];
  readonly mailboxTimestamps: readonly number[];
}

interface AdmissionRejected {
  readonly status: 'rate_limited';
  readonly limitedBy: 'sender' | 'mailbox';
  readonly retryAfterSeconds: number;
}

type Admission = AdmissionAccepted | AdmissionRejected;

export class MailboxCoordinator implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #rate: RateConfig;
  readonly #alarmPublisher: MailboxPublisher;
  readonly #hasCustomAlarmPublisher: boolean;
  #tail: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env, publisher?: MailboxPublisher) {
    this.#state = state;
    this.#env = env;
    this.#rate = readRateConfig(env);
    this.#alarmPublisher = publisher ?? this.#publish.bind(this);
    this.#hasCustomAlarmPublisher = publisher !== undefined;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    let input: SendRequest;
    try {
      input = await request.json<SendRequest>();
      assertRequest(input);
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    try {
      const result = await this.coordinate(input, this.#publish.bind(this));
      const status = result.status === 'rate_limited'
        ? 429
        : result.status === 'publication_failed'
          ? 502
          : 200;
      return Response.json(result, { status });
    } catch {
      return Response.json({ error: 'publication_failed' }, { status: 502 });
    }
  }

  async alarm(): Promise<void> {
    const pendingEntries = await this.#state.storage.list<PendingUpdate>({
      prefix: PENDING_UPDATE_PREFIX
    });
    let needsRetry = false;
    for (const [key, pending] of pendingEntries) {
      let result: PublishMessageResult;
      try {
        result = !this.#hasCustomAlarmPublisher
          ? await this.#resumePending(pending)
          : await this.#alarmPublisher(
              pending.request,
              pending.sequence,
              pending.acceptedAt,
              pending.messageId
            );
      } catch {
        needsRetry = true;
        continue;
      }
      const published = result.status === 'committed' || result.status === 'committed_cleanup_pending';
      if (published) {
        const updateId = Number(key.slice(PENDING_UPDATE_PREFIX.length));
        await this.#state.storage.transaction(async (transaction) => {
          await transaction.put(processedUpdateKey(updateId), {
            sequence: pending.sequence,
            processedAt: Date.now()
          } satisfies ProcessedUpdate);
          await transaction.delete(key);
        });
      } else if (isRetryablePublication(result)) {
        needsRetry = true;
        await this.#state.storage.put(key, {
          ...pending,
          publicationStatus: result.status,
          ...(result.status === 'not_committed' && resumableOperation(result) !== undefined
            ? { failureOperation: resumableOperation(result) }
            : {})
        });
      }
    }
    if (needsRetry) await this.#state.storage.setAlarm(Date.now() + RETRY_DELAY_MILLISECONDS);
  }

  async #publish(
    input: SendRequest,
    _sequence: number,
    acceptedAt: number,
    messageId: string
  ): Promise<PublishMessageResult> {
    return this.#runPublication(input, acceptedAt, messageId);
  }

  async #resumePending(pending: PendingUpdate): Promise<PublishMessageResult> {
    return this.#runPublication(
      pending.request,
      pending.acceptedAt,
      pending.messageId,
      pending.publicationStatus,
      pending.failureOperation
    );
  }

  async #runPublication(
    input: SendRequest,
    acceptedAt: number,
    messageId: string,
    publicationStatus?: PublishMessageResult['status'],
    failureOperation?: 'stage' | 'commit'
  ): Promise<PublishMessageResult> {
    const config = coordinatorPublishConfig(this.#env);
    const store = new CloudflareRecordStoreAdapter({
      apiToken: config.apiToken,
      allowedZones: config.allowedZones,
      correlationId: messageId,
      timeoutMilliseconds: config.timeoutMilliseconds,
      budgetMilliseconds: config.budgetMilliseconds,
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl })
    });
    const envelope = createManagedMessageEnvelope({
      id: messageId,
      i: 1,
      n: 1,
      uid: input.senderId,
      ...(input.senderUsername === undefined ? {} : { username: input.senderUsername }),
      sentAt: new Date(acceptedAt),
      text: input.text
    });
    const request = {
      zoneId: input.zoneId,
      ttl: config.ttl,
      plan: createPublishPlan(input.mailbox, envelope)
    };
    return publicationStatus === 'commit_unknown' ||
      (publicationStatus === 'not_committed' && failureOperation !== undefined)
      ? resumePublishMessage(store, {
          ...request,
          publicationStatus,
          ...(failureOperation === undefined ? {} : { failureOperation })
        })
      : publishMessage(store, request);
  }

  coordinate(
    request: SendRequest,
    publisher: MailboxPublisher,
    now = Date.now()
  ): Promise<CoordinationResult> {
    const operation = this.#tail.then(() => this.#coordinate(request, publisher, now));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #coordinate(
    request: SendRequest,
    publisher: MailboxPublisher,
    now: number
  ): Promise<CoordinationResult> {
    assertRequest(request);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_time');
    const storedClock = await this.#state.storage.get<number>(CLOCK_KEY);
    const monotonicNow = typeof storedClock === 'number' && Number.isSafeInteger(storedClock)
      ? Math.max(now, storedClock)
      : now;
    if (storedClock !== monotonicNow) await this.#state.storage.put(CLOCK_KEY, monotonicNow);

    const processedKey = processedUpdateKey(request.updateId);
    const pendingKey = pendingUpdateKey(request.updateId);
    const processed = await this.#state.storage.get<ProcessedUpdate>(processedKey);
    if (processed !== undefined) return { status: 'duplicate', sequence: processed.sequence };

    let pending = await this.#state.storage.get<PendingUpdate>(pendingKey);
    if (pending === undefined) {
      const admission = await this.#admit(request.senderId, monotonicNow);
      if (admission.status === 'rate_limited') return admission;
      pending = {
        sequence: admission.sequence,
        acceptedAt: monotonicNow,
        messageId: crypto.randomUUID(),
        request
      };
      await this.#state.storage.put(pendingKey, pending);
    } else if (!sameSendRequest(pending.request, request)) {
      throw new Error('update_id_conflict');
    }

    const currentPending = pending;
    const publication = await publisher(
      currentPending.request,
      currentPending.sequence,
      currentPending.acceptedAt,
      currentPending.messageId
    );
    const published = publication.status === 'committed' ||
      publication.status === 'committed_cleanup_pending';
    if (published) {
      await this.#state.storage.transaction(async (transaction) => {
        await transaction.put(processedKey, {
          sequence: currentPending.sequence,
          processedAt: monotonicNow
        } satisfies ProcessedUpdate);
        await transaction.delete(pendingKey);
      });
    } else if (isRetryablePublication(publication)) {
      pending = {
        ...currentPending,
        publicationStatus: publication.status,
        ...(publication.status === 'not_committed' && resumableOperation(publication) !== undefined
          ? { failureOperation: resumableOperation(publication) }
          : {})
      };
      await this.#state.storage.put(pendingKey, pending);
      await this.#state.storage.setAlarm(
        Math.max(monotonicNow, Date.now()) + RETRY_DELAY_MILLISECONDS
      );
    }
    return {
      status: published ? 'published' : 'publication_failed',
      sequence: currentPending.sequence,
      publicationStatus: publication.status
    };
  }

  async #admit(senderId: number, now: number): Promise<Admission> {
    const senderKey = `${SENDER_RATE_PREFIX}${senderId}`;
    const result = await this.#state.storage.transaction(async (transaction): Promise<Admission> => {
      const rates = await transaction.get<readonly number[]>([senderKey, MAILBOX_RATE_KEY]);
      const previousSequence = await transaction.get<number>(NEXT_SEQUENCE_KEY);
      const sender = pruneWindow(rates.get(senderKey), now, this.#rate.windowMilliseconds);
      const mailbox = pruneWindow(rates.get(MAILBOX_RATE_KEY), now, this.#rate.windowMilliseconds);

      if (sender.length >= this.#rate.senderCapacity) {
        return rateLimited('sender', sender[0]!, now, this.#rate.windowMilliseconds);
      }
      if (mailbox.length >= this.#rate.mailboxCapacity) {
        return rateLimited('mailbox', mailbox[0]!, now, this.#rate.windowMilliseconds);
      }

      const sequence = typeof previousSequence === 'number' && Number.isSafeInteger(previousSequence)
        ? previousSequence + 1
        : 1;
      const senderTimestamps = [...sender, now];
      const mailboxTimestamps = [...mailbox, now];
      await transaction.put({
        [senderKey]: senderTimestamps,
        [MAILBOX_RATE_KEY]: mailboxTimestamps,
        [NEXT_SEQUENCE_KEY]: sequence
      });
      return { status: 'accepted', sequence, senderTimestamps, mailboxTimestamps };
    });

    if (result.status === 'accepted') await this.#cleanupIdleSenderBuckets(now, senderKey);
    return result;
  }

  async #cleanupIdleSenderBuckets(now: number, currentSenderKey: string): Promise<void> {
    const cutoff = now - this.#rate.windowMilliseconds * 2;
    const buckets = await this.#state.storage.list<readonly number[]>({ prefix: SENDER_RATE_PREFIX });
    const stale: string[] = [];
    for (const [key, timestamps] of buckets) {
      if (key === currentSenderKey) continue;
      const newest = timestamps.at(-1);
      if (newest === undefined || newest <= cutoff) stale.push(key);
    }
    if (stale.length > 0) await this.#state.storage.delete(stale);
  }
}

function isRetryablePublication(result: PublishMessageResult): boolean {
  if (result.status === 'commit_unknown') return true;
  if (result.status !== 'not_committed') return false;
  return result.failure.code === 'provider_unavailable' ||
    result.failure.code === 'unknown_result' ||
    result.failure.code === 'budget_exhausted';
}

function resumableOperation(
  result: Extract<PublishMessageResult, { readonly status: 'not_committed' }>
): 'stage' | 'commit' | undefined {
  return result.failure.operation === 'stage' || result.failure.operation === 'commit'
    ? result.failure.operation
    : undefined;
}

function readRateConfig(env: Env): RateConfig {
  return {
    senderCapacity: positiveInteger(env.RATE_SENDER_CAPACITY, 5),
    mailboxCapacity: positiveInteger(env.RATE_MAILBOX_CAPACITY, 3),
    windowMilliseconds: positiveInteger(env.RATE_WINDOW_SECONDS, 60) * 1_000
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('invalid_rate_configuration');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid_rate_configuration');
  return parsed;
}

function pruneWindow(
  timestamps: readonly number[] | undefined,
  now: number,
  windowMilliseconds: number
): readonly number[] {
  if (!Array.isArray(timestamps)) return [];
  const cutoff = now - windowMilliseconds;
  return timestamps.filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp > cutoff && timestamp <= now);
}

function rateLimited(
  limitedBy: 'sender' | 'mailbox',
  oldest: number,
  now: number,
  windowMilliseconds: number
): AdmissionRejected {
  return {
    status: 'rate_limited',
    limitedBy,
    retryAfterSeconds: Math.max(0, Math.ceil((oldest + windowMilliseconds - now) / 1_000))
  };
}

function processedUpdateKey(updateId: number): string {
  return `${PROCESSED_UPDATE_PREFIX}${updateId}`;
}

function pendingUpdateKey(updateId: number): string {
  return `${PENDING_UPDATE_PREFIX}${updateId}`;
}

function sameSendRequest(left: SendRequest, right: SendRequest): boolean {
  return left.updateId === right.updateId && left.mailbox === right.mailbox &&
    left.zoneId === right.zoneId && left.text === right.text && left.senderId === right.senderId &&
    left.senderUsername === right.senderUsername;
}

function assertRequest(request: SendRequest): void {
  if (typeof request !== 'object' || request === null ||
      !Number.isSafeInteger(request.updateId) || request.updateId < 0 ||
      typeof request.mailbox !== 'string' || request.mailbox.length === 0 ||
      typeof request.zoneId !== 'string' || request.zoneId.length === 0 ||
      typeof request.text !== 'string' ||
      !Number.isSafeInteger(request.senderId) || request.senderId < 1 ||
      (request.senderUsername !== undefined && typeof request.senderUsername !== 'string')) {
    throw new Error('invalid_request');
  }
}

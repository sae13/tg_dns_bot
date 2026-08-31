import {
  RecordStoreError,
  type RecordStoreErrorCode,
  type RecordStorePort,
  type TxtRecordRequest
} from './record-store';
import { decodeManagedMessage } from '../domain/managed-message-codec';
import { splitTxtCharacterStrings, type PublishPlan, type PublishRecord } from '../domain/publish-plan';

export interface PublishMessageRequest {
  readonly zoneId: string;
  readonly ttl: number;
  readonly plan: PublishPlan;
}

export type PublishMessageErrorCode = 'invalid_plan';

export class PublishMessageError extends Error {
  constructor(readonly code: PublishMessageErrorCode) {
    super(code);
    this.name = 'PublishMessageError';
  }
}

export interface PublicationFailure {
  readonly operation:
    | 'stage'
    | 'commit'
    | 'cleanup_root'
    | 'cleanup_read'
    | 'cleanup_replace'
    | 'cleanup_inventory'
    | 'cleanup_delete';
  readonly code: RecordStoreErrorCode;
}

export type PublishMessageResult =
  | { readonly status: 'committed'; readonly messageId: string }
  | {
      readonly status: 'not_committed';
      readonly messageId: string;
      readonly failure: PublicationFailure;
    }
  | {
      readonly status: 'commit_unknown';
      readonly messageId: string;
      readonly failure: PublicationFailure;
    }
  | {
      readonly status: 'committed_cleanup_pending';
      readonly messageId: string;
      readonly failures: readonly PublicationFailure[];
    };

export async function publishMessage(
  store: RecordStorePort,
  request: PublishMessageRequest
): Promise<PublishMessageResult> {
  validatePublishMessageRequest(request);
  return runPublication(store, request, false);
}

export interface ResumePublishMessageRequest extends PublishMessageRequest {
  readonly publicationStatus: 'not_committed' | 'commit_unknown';
  readonly failureOperation?: 'stage' | 'commit';
}

export async function resumePublishMessage(
  store: RecordStorePort,
  request: ResumePublishMessageRequest
): Promise<PublishMessageResult> {
  validatePublishMessageRequest(request);
  return runPublication(
    store,
    request,
    request.publicationStatus === 'commit_unknown' || request.failureOperation === 'commit',
    request.failureOperation === 'stage'
  );
}

async function runPublication(
  store: RecordStorePort,
  request: PublishMessageRequest,
  resumeUnknownCommit: boolean,
  reconcileStages = false
): Promise<PublishMessageResult> {
  const rootRecord = request.plan.records[0]!;

  if (!resumeUnknownCommit) {
    for (const record of request.plan.records.slice(1)) {
      if (reconcileStages && await exactRecordMatches(store, request.zoneId, record)) continue;
      try {
        await store.appendSingleTxt(recordRequest(request, record));
      } catch (error) {
        const failure = publicationFailure('stage', error);
        if (!isAmbiguousFailure(failure.code) ||
            !(await exactRecordMatches(store, request.zoneId, record))) {
          return {
            status: 'not_committed',
            messageId: request.plan.messageId,
            failure
          };
        }
      }
    }
  }

  const alreadyCommitted = (resumeUnknownCommit || reconcileStages) &&
    await exactRecordMatches(store, request.zoneId, rootRecord);
  if (!alreadyCommitted) {
    try {
      await store.replaceWithSingleTxt(recordRequest(request, rootRecord));
    } catch (error) {
      const failure = publicationFailure('commit', error);
      if (!isAmbiguousFailure(failure.code) ||
          !(await exactRecordMatches(store, request.zoneId, rootRecord))) {
        return {
          status: isAmbiguousFailure(failure.code) ? 'commit_unknown' : 'not_committed',
          messageId: request.plan.messageId,
          failure
        };
      }
    }
  }

  return cleanupPublication(store, request);
}

async function cleanupPublication(
  store: RecordStorePort,
  request: PublishMessageRequest
): Promise<PublishMessageResult> {
  const failures: PublicationFailure[] = [];
  for (const record of request.plan.records.slice(1)) {
    try {
      await store.replaceWithSingleTxt(recordRequest(request, record));
    } catch (error) {
      failures.push(publicationFailure('cleanup_replace', error));
    }
  }

  try {
    const inventory = await store.listNumberedTxtRecords({
      zoneId: request.zoneId,
      rootName: request.plan.rootName
    });
    if (inventory.status === 'found') {
      const currentNames = new Set(request.plan.records.slice(1).map(({ name }) => name));
      for (const name of inventory.names) {
        if (currentNames.has(name)) continue;
        try {
          await store.deleteTxtRecords({ zoneId: request.zoneId, name });
        } catch (error) {
          failures.push(publicationFailure('cleanup_delete', error));
        }
      }
    }
  } catch (error) {
    failures.push(publicationFailure('cleanup_inventory', error));
  }

  return failures.length === 0
    ? { status: 'committed', messageId: request.plan.messageId }
    : {
        status: 'committed_cleanup_pending',
        messageId: request.plan.messageId,
        failures: Object.freeze(failures)
      };
}

export interface ReconcilePublicationCleanupRequest {
  readonly zoneId: string;
  readonly rootName: string;
  readonly ttl: number;
}

export type ReconcilePublicationCleanupResult =
  | { readonly status: 'nothing_to_reconcile' }
  | { readonly status: 'reconciled'; readonly messageId: string }
  | {
      readonly status: 'cleanup_pending';
      readonly messageId: string | null;
      readonly failures: readonly PublicationFailure[];
    };

export async function reconcilePublicationCleanup(
  store: RecordStorePort,
  request: ReconcilePublicationCleanupRequest
): Promise<ReconcilePublicationCleanupResult> {
  let rootResult: Awaited<ReturnType<RecordStorePort['readExactTxtRecords']>>;
  try {
    rootResult = await store.readExactTxtRecords({ zoneId: request.zoneId, name: request.rootName });
  } catch (error) {
    return pending(null, [publicationFailure('cleanup_root', error)]);
  }
  if (rootResult.status === 'not_found') return { status: 'nothing_to_reconcile' };

  const rootCandidates = uniqueMatchingEnvelopes(
    rootResult.records.map(({ wire }) => wire),
    1,
    null,
    null,
    null,
    false
  );
  if (rootCandidates.length !== 1) {
    return pending(null, [{ operation: 'cleanup_root', code: 'ambiguous_result' }]);
  }
  const root = rootCandidates[0]!;
  if (root.n === 1) {
    return reconcileInventory(store, request, root.id, new Set<string>());
  }

  const failures: PublicationFailure[] = [];
  const currentNames = new Set<string>();
  for (let index = 2; index <= root.n; index += 1) {
    const name = `${index}.${request.rootName}`;
    currentNames.add(name);
    let partResult: Awaited<ReturnType<RecordStorePort['readExactTxtRecords']>>;
    try {
      partResult = await store.readExactTxtRecords({ zoneId: request.zoneId, name });
    } catch (error) {
      failures.push(publicationFailure('cleanup_read', error));
      continue;
    }
    if (partResult.status === 'not_found') {
      failures.push({ operation: 'cleanup_read', code: 'ambiguous_result' });
      continue;
    }

    const candidates = uniqueMatchingEnvelopes(
      partResult.records.map(({ wire }) => wire),
      index,
      root.n,
      root.id,
      root
    );
    if (candidates.length !== 1) {
      failures.push({ operation: 'cleanup_read', code: 'ambiguous_result' });
      continue;
    }
    const candidate = candidates[0]!;
    try {
      await store.replaceWithSingleTxt({
        zoneId: request.zoneId,
        name,
        ttl: request.ttl,
        characterStrings: splitTxtCharacterStrings(candidate.wire)
      });
    } catch (error) {
      failures.push(publicationFailure('cleanup_replace', error));
    }
  }

  const inventoryResult = await reconcileInventory(store, request, root.id, currentNames);
  if (inventoryResult.status === 'cleanup_pending') failures.push(...inventoryResult.failures);
  return failures.length === 0
    ? { status: 'reconciled', messageId: root.id }
    : pending(root.id, failures);
}

async function reconcileInventory(
  store: RecordStorePort,
  request: ReconcilePublicationCleanupRequest,
  messageId: string,
  currentNames: ReadonlySet<string>
): Promise<ReconcilePublicationCleanupResult> {
  const failures: PublicationFailure[] = [];
  let inventory: Awaited<ReturnType<RecordStorePort['listNumberedTxtRecords']>>;
  try {
    inventory = await store.listNumberedTxtRecords({
      zoneId: request.zoneId,
      rootName: request.rootName
    });
  } catch (error) {
    return pending(messageId, [publicationFailure('cleanup_inventory', error)]);
  }
  if (inventory.status === 'found') {
    for (const name of inventory.names) {
      if (currentNames.has(name)) continue;
      try {
        await store.deleteTxtRecords({ zoneId: request.zoneId, name });
      } catch (error) {
        failures.push(publicationFailure('cleanup_delete', error));
      }
    }
  }
  return failures.length === 0
    ? { status: 'reconciled', messageId }
    : pending(messageId, failures);
}

interface ReconcileCandidate {
  readonly wire: string;
  readonly id: string;
  readonly i: number;
  readonly n: number;
  readonly uid: number;
  readonly username: string | null;
  readonly ts: string;
}

function uniqueMatchingEnvelopes(
  wires: readonly string[],
  index: number,
  partCount: number | null,
  messageId: string | null,
  metadata: Pick<ReconcileCandidate, 'uid' | 'username' | 'ts'> | null = null,
  deduplicate = true
): readonly ReconcileCandidate[] {
  const candidates: ReconcileCandidate[] = [];
  const seenWires = new Set<string>();
  for (const wire of wires) {
    const decoded = decodeManagedMessage(wire);
    if (decoded.status !== 'valid' || decoded.envelope.i !== index ||
        (partCount !== null && decoded.envelope.n !== partCount) ||
        (messageId !== null && decoded.envelope.id !== messageId) ||
        (metadata !== null && (
          decoded.envelope.uid !== metadata.uid ||
          decoded.envelope.username !== metadata.username ||
          decoded.envelope.ts !== metadata.ts
        ))) {
      continue;
    }
    if (deduplicate && seenWires.has(wire)) continue;
    seenWires.add(wire);
    candidates.push({
      wire,
      id: decoded.envelope.id,
      i: decoded.envelope.i,
      n: decoded.envelope.n,
      uid: decoded.envelope.uid,
      username: decoded.envelope.username,
      ts: decoded.envelope.ts
    });
  }
  return candidates;
}

function pending(
  messageId: string | null,
  failures: readonly PublicationFailure[]
): ReconcilePublicationCleanupResult {
  return { status: 'cleanup_pending', messageId, failures: Object.freeze([...failures]) };
}

function validatePublishMessageRequest(request: PublishMessageRequest): void {
  if (typeof request !== 'object' || request === null || typeof request.zoneId !== 'string' ||
      !Number.isInteger(request.ttl) || typeof request.plan !== 'object' || request.plan === null ||
      typeof request.plan.rootName !== 'string' || typeof request.plan.messageId !== 'string' ||
      !Array.isArray(request.plan.records) || request.plan.records.length === 0) {
    throw new PublishMessageError('invalid_plan');
  }
  let rootMetadata: Pick<ReconcileCandidate, 'uid' | 'username' | 'ts'> | null = null;
  for (const [index, record] of request.plan.records.entries()) {
    if (typeof record !== 'object' || record === null || typeof record.wire !== 'string' ||
        !Array.isArray(record.characterStrings) ||
        record.characterStrings.some((part: unknown) => typeof part !== 'string') ||
        record.name !== (index === 0 ? request.plan.rootName : `${index + 1}.${request.plan.rootName}`) ||
        record.wire !== record.characterStrings.join('')) {
      throw new PublishMessageError('invalid_plan');
    }
    const decoded = decodeManagedMessage(record.wire);
    if (decoded.status !== 'valid' || decoded.envelope.id !== request.plan.messageId ||
        decoded.envelope.i !== index + 1 || decoded.envelope.n !== request.plan.records.length ||
        (rootMetadata !== null && (
          decoded.envelope.uid !== rootMetadata.uid ||
          decoded.envelope.username !== rootMetadata.username ||
          decoded.envelope.ts !== rootMetadata.ts
        ))) {
      throw new PublishMessageError('invalid_plan');
    }
    rootMetadata ??= decoded.envelope;
  }
}

function recordRequest(request: PublishMessageRequest, record: PublishRecord): TxtRecordRequest {
  return {
    zoneId: request.zoneId,
    name: record.name,
    ttl: request.ttl,
    characterStrings: record.characterStrings
  };
}

function isAmbiguousFailure(code: RecordStoreErrorCode): boolean {
  return code === 'unknown_result' || code === 'budget_exhausted';
}

async function exactRecordMatches(
  store: RecordStorePort,
  zoneId: string,
  record: PublishRecord
): Promise<boolean> {
  try {
    const result = await store.readExactTxtRecords({ zoneId, name: record.name });
    if (result.status !== 'found') return false;
    const matches = result.records.filter(({ wire }) => wire === record.wire);
    return matches.length === 1;
  } catch {
    return false;
  }
}

function publicationFailure(
  operation: PublicationFailure['operation'],
  error: unknown
): PublicationFailure {
  return {
    operation,
    code: error instanceof RecordStoreError ? error.code : 'provider_error'
  };
}

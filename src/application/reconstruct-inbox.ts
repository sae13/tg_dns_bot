import {
  decodeManagedMessage,
  type ManagedMessageDecodeError
} from '../domain/managed-message-codec';
import { canonicalizeMailbox } from '../domain/mailbox';
import type { ManagedMessageEnvelope } from '../domain/managed-message';
import type { TxtRecord, TxtResolution, TxtResolverPort } from './txt-resolver';

export const MAX_INBOX_CHUNK_COUNT = 100;

export type InboxQueryResolution = TxtResolution | { readonly status: 'resolver_error' };

export interface InboxQueryEvidence {
  readonly name: string;
  readonly resolution: InboxQueryResolution;
}

export interface MalformedManagedRecord {
  readonly name: string;
  readonly record: TxtRecord;
  readonly error: ManagedMessageDecodeError;
}

export interface ReconstructedManagedMessage {
  readonly v: ManagedMessageEnvelope['v'];
  readonly id: string;
  readonly n: number;
  readonly uid: number;
  readonly username: string | null;
  readonly ts: string;
  readonly text: string;
}

interface InboxEvidence {
  readonly name: string;
  readonly queries: readonly InboxQueryEvidence[];
  readonly malformed: readonly MalformedManagedRecord[];
}

export type InboxState =
  | ({
    readonly status: 'absent';
    readonly reason: Exclude<InboxQueryResolution['status'], 'found'>;
  } & InboxEvidence)
  | ({ readonly status: 'raw_only' } & InboxEvidence)
  | ({
    readonly status: 'complete';
    readonly message: ReconstructedManagedMessage;
    readonly chunks: readonly ManagedMessageEnvelope[];
  } & InboxEvidence)
  | ({ readonly status: 'ambiguous'; readonly roots: readonly ManagedMessageEnvelope[] } & InboxEvidence)
  | ({
    readonly status: 'incomplete';
    readonly manifest: ManagedMessageEnvelope;
    readonly chunks: readonly ManagedMessageEnvelope[];
    readonly problems: readonly InboxReconstructionProblem[];
  } & InboxEvidence);

export type InboxReconstructionProblem =
  | { readonly kind: 'missing_chunk'; readonly index: number; readonly name: string }
  | { readonly kind: 'duplicate_chunk'; readonly index: number; readonly name: string }
  | { readonly kind: 'conflicting_chunk'; readonly index: number; readonly name: string }
  | { readonly kind: 'incompatible_chunk'; readonly index: number; readonly name: string }
  | { readonly kind: 'malformed_chunk'; readonly index: number; readonly name: string }
  | { readonly kind: 'malformed_root'; readonly name: string }
  | { readonly kind: 'incompatible_root'; readonly name: string }
  | { readonly kind: 'chunk_count_exceeded'; readonly count: number; readonly maximum: number }
  | { readonly kind: 'invalid_chunk_name'; readonly index: number; readonly name: string }
  | {
    readonly kind: 'chunk_lookup_failed';
    readonly index: number;
    readonly name: string;
    readonly resolution: Exclude<InboxQueryResolution['status'], 'found'>;
  };

export async function reconstructInbox(name: string, resolver: TxtResolverPort): Promise<InboxState> {
  const rootResolution = await resolveSafely(resolver, name);
  const queries: InboxQueryEvidence[] = [{ name, resolution: rootResolution }];
  if (rootResolution.status !== 'found') {
    return { status: 'absent', name, reason: rootResolution.status, queries, malformed: [] };
  }

  const { valid: rootCandidates, malformed } = decodeCandidateRecords(rootResolution.records);
  const roots = rootCandidates.filter((candidate) => candidate.i === 1);
  if (roots.length === 0) return { status: 'raw_only', name, queries, malformed };
  if (roots.length > 1) return { status: 'ambiguous', name, roots, queries, malformed };

  const manifest = roots[0]!;
  const chunks: ManagedMessageEnvelope[] = [manifest];
  const problems: InboxReconstructionProblem[] = [];
  if (malformed.length > 0) problems.push({ kind: 'malformed_root', name });
  if (rootCandidates.length !== roots.length) problems.push({ kind: 'incompatible_root', name });
  if (manifest.n > MAX_INBOX_CHUNK_COUNT) {
    problems.push({ kind: 'chunk_count_exceeded', count: manifest.n, maximum: MAX_INBOX_CHUNK_COUNT });
    return { status: 'incomplete', name, manifest, chunks, queries, malformed, problems };
  }

  for (let index = 2; index <= manifest.n; index += 1) {
    const chunkName = `${index}.${name}`;
    if (canonicalizeMailbox(chunkName) !== chunkName) {
      problems.push({ kind: 'invalid_chunk_name', index, name: chunkName });
      continue;
    }
    const resolution = await resolveSafely(resolver, chunkName);
    queries.push({ name: chunkName, resolution });
    if (resolution.status !== 'found') {
      problems.push({ kind: 'chunk_lookup_failed', index, name: chunkName, resolution: resolution.status });
      continue;
    }

    const decoded = decodeCandidateRecords(resolution.records);
    malformed.push(...decoded.malformed);
    const compatible = decoded.valid.filter((candidate) =>
      candidate.i === index && sameMessageIdentity(candidate, manifest)
    );
    if (compatible.length === 1) {
      chunks.push(compatible[0]!);
      if (decoded.malformed.length > 0) {
        problems.push({ kind: 'malformed_chunk', index, name: chunkName });
      }
      if (decoded.valid.length !== compatible.length) {
        problems.push({ kind: 'incompatible_chunk', index, name: chunkName });
      }
    } else if (compatible.length > 1) {
      const duplicate = compatible.every((candidate) => envelopesEqual(candidate, compatible[0]!));
      problems.push({ kind: duplicate ? 'duplicate_chunk' : 'conflicting_chunk', index, name: chunkName });
      chunks.push(...compatible);
    } else if (decoded.valid.length > 0) {
      problems.push({ kind: 'incompatible_chunk', index, name: chunkName });
    } else {
      problems.push({
        kind: decoded.malformed.length > 0 ? 'malformed_chunk' : 'missing_chunk',
        index,
        name: chunkName
      });
    }
  }

  if (problems.length === 0) {
    return {
      status: 'complete',
      name,
      message: reconstructedMessage(chunks),
      chunks,
      queries,
      malformed
    };
  }
  return { status: 'incomplete', name, manifest, chunks, queries, malformed, problems };
}

async function resolveSafely(resolver: TxtResolverPort, name: string): Promise<InboxQueryResolution> {
  try {
    return await resolver.resolveTxt(name);
  } catch {
    return { status: 'resolver_error' };
  }
}

function decodeCandidateRecords(records: readonly TxtRecord[]): {
  readonly valid: ManagedMessageEnvelope[];
  readonly malformed: MalformedManagedRecord[];
} {
  const valid: ManagedMessageEnvelope[] = [];
  const malformed: MalformedManagedRecord[] = [];
  for (const record of records) {
    const decoded = decodeManagedMessage(record.value);
    if (decoded.status === 'valid') {
      valid.push(decoded.envelope);
    } else if (record.value.startsWith('tgdn')) {
      malformed.push({ name: record.name, record, error: decoded.error });
    }
  }
  return { valid, malformed };
}

function sameMessageIdentity(candidate: ManagedMessageEnvelope, manifest: ManagedMessageEnvelope): boolean {
  return candidate.v === manifest.v && candidate.id === manifest.id && candidate.n === manifest.n &&
    candidate.uid === manifest.uid && candidate.username === manifest.username && candidate.ts === manifest.ts;
}

function envelopesEqual(left: ManagedMessageEnvelope, right: ManagedMessageEnvelope): boolean {
  return left.v === right.v && left.id === right.id && left.i === right.i && left.n === right.n &&
    left.uid === right.uid && left.username === right.username && left.ts === right.ts && left.text === right.text;
}

function reconstructedMessage(chunks: readonly ManagedMessageEnvelope[]): ReconstructedManagedMessage {
  const root = chunks[0]!;
  return {
    v: root.v,
    id: root.id,
    n: root.n,
    uid: root.uid,
    username: root.username,
    ts: root.ts,
    text: chunks.map((chunk) => chunk.text).join('')
  };
}

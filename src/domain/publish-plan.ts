import { canonicalizeMailbox } from './mailbox';
import {
  MANAGED_MESSAGE_PREFIX,
  encodeManagedMessage
} from './managed-message-codec';
import {
  assertManagedMessageEnvelope,
  createManagedMessageEnvelope,
  type ManagedMessageEnvelope
} from './managed-message';

export const TXT_RECORD_WIRE_BYTE_LIMIT = 4_096;
export const TXT_CHARACTER_STRING_BYTE_LIMIT = 255;

export type TxtCharacterStringErrorCode = 'invalid_payload';

export class TxtCharacterStringError extends Error {
  constructor(readonly code: TxtCharacterStringErrorCode) {
    super(code);
    this.name = 'TxtCharacterStringError';
  }
}

export type PublishPlanErrorCode =
  | 'invalid_root_name'
  | 'invalid_source'
  | 'record_name_too_long'
  | 'message_unrepresentable';

export class PublishPlanError extends Error {
  constructor(readonly code: PublishPlanErrorCode) {
    super(code);
    this.name = 'PublishPlanError';
  }
}

export interface PublishRecord {
  readonly name: string;
  readonly envelope: ManagedMessageEnvelope;
  readonly wire: string;
  readonly characterStrings: readonly string[];
}

export interface PublishPlan {
  readonly rootName: string;
  readonly messageId: string;
  readonly records: readonly PublishRecord[];
}

const textEncoder = new TextEncoder();

export function splitTxtCharacterStrings(payload: string): readonly string[] {
  if (typeof payload !== 'string') throw new TxtCharacterStringError('invalid_payload');
  if (payload.length === 0) return Object.freeze(['']);

  const parts: string[] = [];
  let current = '';
  let currentByteLength = 0;

  for (const codePoint of payload) {
    const codePointByteLength = wireByteLength(codePoint);
    if (currentByteLength + codePointByteLength > TXT_CHARACTER_STRING_BYTE_LIMIT) {
      parts.push(current);
      current = codePoint;
      currentByteLength = codePointByteLength;
    } else {
      current += codePoint;
      currentByteLength += codePointByteLength;
    }
  }

  parts.push(current);
  return Object.freeze(parts);
}

export function createPublishPlan(
  rootName: string,
  source: ManagedMessageEnvelope
): PublishPlan {
  assertManagedMessageEnvelope(source);
  if (source.i !== 1 || source.n !== 1) throw new PublishPlanError('invalid_source');
  const canonicalSource = createPartEnvelope(source, 1, 1, source.text);
  if (typeof rootName !== 'string') throw new PublishPlanError('invalid_root_name');
  const canonicalRootName = canonicalizeMailbox(rootName);
  if (canonicalRootName === null || canonicalRootName !== rootName) {
    throw new PublishPlanError('invalid_root_name');
  }

  const singleWire = encodeManagedMessage(canonicalSource);
  if (wireByteLength(singleWire) <= TXT_RECORD_WIRE_BYTE_LIMIT) {
    return freezePlan(rootName, source.id, [createPublishRecord(rootName, canonicalSource, singleWire)]);
  }

  const codePoints = [...source.text];
  const minimumPartCount = minimumCandidatePartCount(source, codePoints);
  if (codePoints.length === 0 || minimumPartCount === null) {
    throw new PublishPlanError('message_unrepresentable');
  }

  for (let partCount = minimumPartCount; partCount <= codePoints.length; partCount += 1) {
    const names = createRecordNames(rootName, partCount);
    const envelopes = partitionForPartCount(source, codePoints, partCount);
    if (envelopes === null) continue;

    const records = envelopes.map((envelope, index) =>
      createPublishRecord(names[index]!, envelope, encodeManagedMessage(envelope))
    );
    return freezePlan(rootName, source.id, records);
  }

  throw new PublishPlanError('message_unrepresentable');
}

function partitionForPartCount(
  source: ManagedMessageEnvelope,
  codePoints: readonly string[],
  partCount: number
): readonly ManagedMessageEnvelope[] | null {
  const envelopes: ManagedMessageEnvelope[] = [];
  let start = 0;

  for (let partIndex = 1; partIndex <= partCount; partIndex += 1) {
    const remainingParts = partCount - partIndex;
    const maximumEnd = codePoints.length - remainingParts;
    const end = largestFittingEnd(source, codePoints, start, maximumEnd, partIndex, partCount);
    if (end === null) return null;

    envelopes.push(createPartEnvelope(source, partIndex, partCount, codePoints.slice(start, end).join('')));
    start = end;
  }

  return start === codePoints.length ? envelopes : null;
}

function largestFittingEnd(
  source: ManagedMessageEnvelope,
  codePoints: readonly string[],
  start: number,
  maximumEnd: number,
  partIndex: number,
  partCount: number
): number | null {
  let low = start + 1;
  let high = maximumEnd;
  let best: number | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const envelope = createPartEnvelope(
      source,
      partIndex,
      partCount,
      codePoints.slice(start, middle).join('')
    );

    if (wireByteLength(encodeManagedMessage(envelope)) <= TXT_RECORD_WIRE_BYTE_LIMIT) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function createPartEnvelope(
  source: ManagedMessageEnvelope,
  partIndex: number,
  partCount: number,
  text: string
): ManagedMessageEnvelope {
  return createManagedMessageEnvelope({
    id: source.id,
    i: partIndex,
    n: partCount,
    uid: source.uid,
    username: source.username,
    sentAt: new Date(source.ts),
    text
  });
}

function createRecordNames(rootName: string, partCount: number): readonly string[] {
  const names = Array.from({ length: partCount }, (_, index) =>
    index === 0 ? rootName : `${index + 1}.${rootName}`
  );
  if (names.some((name) => canonicalizeMailbox(name) !== name)) {
    throw new PublishPlanError('record_name_too_long');
  }
  return names;
}

function minimumCandidatePartCount(
  source: ManagedMessageEnvelope,
  codePoints: readonly string[]
): number | null {
  if (codePoints.length === 0) return null;

  const emptySource = createPartEnvelope(source, 1, 1, '');
  const encodedTextJsonBytes = canonicalJsonUtf8ByteLength(source) - canonicalJsonUtf8ByteLength(emptySource);
  for (let digitCount = 1; digitCount <= String(codePoints.length).length; digitCount += 1) {
    const representativeCount = digitCount === 1 ? 2 : 10 ** (digitCount - 1);
    if (representativeCount > codePoints.length) continue;

    const representative = createPartEnvelope(source, 1, representativeCount, '');
    const jsonByteLength = canonicalJsonUtf8ByteLength(representative);
    const availableJsonBytes = maximumJsonByteLengthForWire() - jsonByteLength;
    if (availableJsonBytes < 1) continue;

    const optimisticPartCount = Math.max(2, Math.ceil(encodedTextJsonBytes / availableJsonBytes));
    if (String(optimisticPartCount).length === digitCount) return optimisticPartCount;
  }

  return null;
}

function maximumJsonByteLengthForWire(): number {
  const maximumBase64Length = TXT_RECORD_WIRE_BYTE_LIMIT - MANAGED_MESSAGE_PREFIX.length;
  return Math.floor(maximumBase64Length * 3 / 4);
}

function canonicalJsonUtf8ByteLength(envelope: ManagedMessageEnvelope): number {
  const wirePayloadLength = encodeManagedMessage(envelope).length - MANAGED_MESSAGE_PREFIX.length;
  const padding = (4 - wirePayloadLength % 4) % 4;
  return (wirePayloadLength + padding) / 4 * 3 - padding;
}

function createPublishRecord(
  name: string,
  envelope: ManagedMessageEnvelope,
  wire: string
): PublishRecord {
  return {
    name,
    envelope,
    wire,
    characterStrings: splitTxtCharacterStrings(wire)
  };
}

function freezePlan(
  rootName: string,
  messageId: string,
  records: readonly PublishRecord[]
): PublishPlan {
  const frozenRecords = Object.freeze(records.map((record) => Object.freeze(record)));
  return Object.freeze({ rootName, messageId, records: frozenRecords });
}

function wireByteLength(wire: string): number {
  return textEncoder.encode(wire).length;
}

export const MANAGED_MESSAGE_VERSION = 1 as const;

export interface ManagedMessageEnvelope {
  readonly v: typeof MANAGED_MESSAGE_VERSION;
  readonly id: string;
  readonly i: number;
  readonly n: number;
  readonly uid: number;
  readonly username: string | null;
  readonly ts: string;
  readonly text: string;
}

export interface CreateManagedMessageEnvelopeInput {
  readonly id: string;
  readonly i: number;
  readonly n: number;
  readonly uid: number;
  readonly username?: string | null;
  readonly sentAt: Date;
  readonly text: string;
}

export class InvalidManagedMessageError extends Error {
  constructor() {
    super('Invalid managed message');
    this.name = 'InvalidManagedMessageError';
  }
}

export function assertManagedMessageEnvelope(value: unknown): asserts value is ManagedMessageEnvelope {
  if (parseManagedMessageEnvelope(value) === null) throw new InvalidManagedMessageError();
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENVELOPE_KEYS = ['v', 'id', 'i', 'n', 'uid', 'username', 'ts', 'text'] as const;

export function createManagedMessageEnvelope(input: CreateManagedMessageEnvelopeInput): ManagedMessageEnvelope {
  if (!CANONICAL_UUID.test(input.id) ||
      !isValidPartPosition(input.i, input.n) ||
      !isValidTelegramUserId(input.uid) ||
      !(input.sentAt instanceof Date) || !Number.isFinite(input.sentAt.getTime()) ||
      typeof input.text !== 'string' ||
      (input.username !== undefined && input.username !== null && typeof input.username !== 'string')) {
    throw new InvalidManagedMessageError();
  }

  return Object.freeze({
    v: MANAGED_MESSAGE_VERSION,
    id: input.id,
    i: input.i,
    n: input.n,
    uid: input.uid,
    username: input.username ?? null,
    ts: Date.prototype.toISOString.call(input.sentAt),
    text: input.text
  });
}

export function parseManagedMessageEnvelope(value: unknown): ManagedMessageEnvelope | null {
  if (!isRecord(value) || !hasExactEnvelopeKeys(value) ||
      value.v !== MANAGED_MESSAGE_VERSION || typeof value.id !== 'string' || !CANONICAL_UUID.test(value.id) ||
      typeof value.i !== 'number' || typeof value.n !== 'number' || !isValidPartPosition(value.i, value.n) ||
      typeof value.uid !== 'number' || !isValidTelegramUserId(value.uid) ||
      (value.username !== null && typeof value.username !== 'string') ||
      typeof value.ts !== 'string' || !isCanonicalUtcTimestamp(value.ts) ||
      typeof value.text !== 'string') {
    return null;
  }

  return Object.freeze({
    v: value.v,
    id: value.id,
    i: value.i,
    n: value.n,
    uid: value.uid,
    username: value.username,
    ts: value.ts,
    text: value.text
  });
}

function isValidPartPosition(index: number, count: number): boolean {
  return Number.isSafeInteger(index) && index >= 1 &&
    Number.isSafeInteger(count) && count >= 1 && index <= count;
}

function isValidTelegramUserId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function hasExactEnvelopeKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === ENVELOPE_KEYS.length && ENVELOPE_KEYS.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function generateMessageId(): string {
  return crypto.randomUUID();
}

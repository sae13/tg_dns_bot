import { describe, expect, it } from 'vitest';
import { decodeManagedMessage, encodeManagedMessage } from '../src/domain/managed-message-codec';
import {
  InvalidManagedMessageError,
  createManagedMessageEnvelope,
  type ManagedMessageEnvelope
} from '../src/domain/managed-message';
import {
  PublishPlanError,
  TXT_RECORD_WIRE_BYTE_LIMIT,
  createPublishPlan
} from '../src/domain/publish-plan';

const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174000';
const ROOT_NAME = 'hello.salam.ifrom.ir';
const byteLength = (value: string) => new TextEncoder().encode(value).length;

function message(text: string, overrides: Partial<ManagedMessageEnvelope> = {}) {
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

function asciiTextForExactWireBytes(target: number): string {
  for (let length = 0; length <= 5_000; length += 1) {
    const text = 'a'.repeat(length);
    if (byteLength(encodeManagedMessage(message(text))) === target) return text;
  }
  throw new Error(`No ASCII fixture produces ${target} wire bytes`);
}

function expectValidPlanRoundTrip(plan: ReturnType<typeof createPublishPlan>, source: ManagedMessageEnvelope) {
  const decoded = plan.records.map((record) => decodeManagedMessage(record.wire));
  const envelopes = decoded.map((result) => {
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('Expected a valid managed message');
    return result.envelope;
  });

  expect(envelopes.map((envelope) => envelope.text).join('')).toBe(source.text);
  for (const [zeroBasedIndex, envelope] of envelopes.entries()) {
    expect(envelope).toMatchObject({
      v: source.v,
      id: source.id,
      i: zeroBasedIndex + 1,
      n: envelopes.length,
      uid: source.uid,
      username: source.username,
      ts: source.ts
    });
  }
}

describe('createPublishPlan', () => {
  it('uses only the root record when the final encoded payload fits', () => {
    const source = message('سلام 👋 "quoted" \\ mixed');

    const plan = createPublishPlan(ROOT_NAME, source);

    expect(plan.rootName).toBe(ROOT_NAME);
    expect(plan.messageId).toBe(MESSAGE_ID);
    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toEqual({
      name: ROOT_NAME,
      envelope: source,
      wire: encodeManagedMessage(source),
      characterStrings: expect.any(Array)
    });
    expect(plan.records[0]!.characterStrings.join('')).toBe(plan.records[0]!.wire);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.records)).toBe(true);
    expect(Object.isFrozen(plan.records[0])).toBe(true);
    expect(Object.isFrozen(plan.records[0]!.envelope)).toBe(true);
    expect(Object.isFrozen(plan.records[0]!.characterStrings)).toBe(true);
  });

  it.each([
    ['largest representable wire below the boundary', 4_094],
    ['wire exactly on the boundary', TXT_RECORD_WIRE_BYTE_LIMIT]
  ])('keeps a %s in one root record', (_case, targetBytes) => {
    const source = message(asciiTextForExactWireBytes(targetBytes));

    const plan = createPublishPlan(ROOT_NAME, source);

    expect(byteLength(plan.records[0]!.wire)).toBe(targetBytes);
    expect(plan.records).toHaveLength(1);
    expectValidPlanRoundTrip(plan, source);
  });

  it('splits the smallest representable wire above the boundary', () => {
    const source = message(asciiTextForExactWireBytes(4_097));

    const plan = createPublishPlan(ROOT_NAME, source);

    expect(plan.records).toHaveLength(2);
    expect(plan.records.every((record) => byteLength(record.wire) <= TXT_RECORD_WIRE_BYTE_LIMIT)).toBe(true);
    expectValidPlanRoundTrip(plan, source);
  });

  it.each([
    ['Persian', 'پیام بلند فارسی '],
    ['emoji including astral code points', '😀🧑🏽💻🚀'],
    ['JSON-escaped quotes and backslashes', '"quoted"\\path\\'],
    ['decomposed combining text', 'éå']
  ])('round-trips chunk boundaries for %s', (_case, pattern) => {
    const source = message(pattern.repeat(1_000));

    const plan = createPublishPlan(ROOT_NAME, source);

    expect(plan.records.length).toBeGreaterThan(1);
    expect(plan.records.every((record) => byteLength(record.wire) <= TXT_RECORD_WIRE_BYTE_LIMIT)).toBe(true);
    expectValidPlanRoundTrip(plan, source);
  });

  it('creates the deterministic minimum-size numbered plan with consistent metadata', () => {
    const source = message(('فارسی😀"\\é').repeat(600));

    const first = createPublishPlan(ROOT_NAME, source);
    const second = createPublishPlan(ROOT_NAME, source);

    expect(first).toEqual(second);
    expect(first.records.length).toBeGreaterThan(2);
    expect(first.records.map((record) => record.name)).toEqual([
      ROOT_NAME,
      ...Array.from({ length: first.records.length - 1 }, (_, index) => `${index + 2}.${ROOT_NAME}`)
    ]);
    expect(first.records.every((record) => byteLength(record.wire) <= TXT_RECORD_WIRE_BYTE_LIMIT)).toBe(true);
    expect(first.records.every((record) => record.characterStrings.join('') === record.wire)).toBe(true);
    expect(first.records.flatMap((record) => record.characterStrings).every((part) => byteLength(part) <= 255)).toBe(true);
    expectValidPlanRoundTrip(first, source);
  });

  it('handles multi-digit part counts without changing order or metadata', () => {
    const source = message('😀'.repeat(2_000), { username: 'u'.repeat(2_400) });

    const plan = createPublishPlan(ROOT_NAME, source);

    expect(plan.records.length).toBeGreaterThanOrEqual(10);
    expect(plan.records[9]!.name).toBe(`10.${ROOT_NAME}`);
    expectValidPlanRoundTrip(plan, source);
  });

  it('rejects the whole plan when a required numbered record name exceeds DNS limits', () => {
    const maximumRoot = [63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.');
    const source = message('😀'.repeat(1_000));

    expect(() => createPublishPlan(maximumRoot, source)).toThrowError(
      expect.objectContaining<Partial<PublishPlanError>>({ code: 'record_name_too_long' })
    );
  });

  it('rejects metadata that cannot fit even with an empty text part', () => {
    const source = message('', { username: 'u'.repeat(4_000) });

    expect(() => createPublishPlan(ROOT_NAME, source)).toThrowError(
      expect.objectContaining<Partial<PublishPlanError>>({ code: 'message_unrepresentable' })
    );
  });

  it('rejects a non-canonical root and a source that is already a partial envelope', () => {
    expect(() => createPublishPlan('Hello.Salam.Ifrom.Ir.', message('x'))).toThrowError(
      expect.objectContaining<Partial<PublishPlanError>>({ code: 'invalid_root_name' })
    );
    expect(() => createPublishPlan(ROOT_NAME, message('x', { i: 2, n: 3 }))).toThrowError(
      expect.objectContaining<Partial<PublishPlanError>>({ code: 'invalid_source' })
    );
  });

  it('preserves managed-envelope runtime validation at the planner boundary', () => {
    const invalid = message('x', { i: 2, n: 1 });
    expect(() => createPublishPlan(ROOT_NAME, invalid)).toThrow(InvalidManagedMessageError);
  });
});

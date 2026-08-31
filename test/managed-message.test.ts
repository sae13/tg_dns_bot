import { describe, expect, it } from 'vitest';
import {
  InvalidManagedMessageError,
  createManagedMessageEnvelope,
  generateMessageId,
  type CreateManagedMessageEnvelopeInput
} from '../src/domain/managed-message';

const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('createManagedMessageEnvelope', () => {
  it('creates an immutable version-one envelope with UTC time and a nullable username', () => {
    const envelope = createManagedMessageEnvelope({
      id: MESSAGE_ID,
      i: 1,
      n: 1,
      uid: 4_503_599_627_370_495,
      sentAt: new Date('2026-08-30T15:45:12.345+03:30'),
      text: 'سلام 👋 "quoted" \\ mixed'
    });

    expect(envelope).toEqual({
      v: 1,
      id: MESSAGE_ID,
      i: 1,
      n: 1,
      uid: 4_503_599_627_370_495,
      username: null,
      ts: '2026-08-30T12:15:12.345Z',
      text: 'سلام 👋 "quoted" \\ mixed'
    });
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it('preserves a present username', () => {
    expect(createManagedMessageEnvelope({
      id: MESSAGE_ID,
      i: 2,
      n: 3,
      uid: 42,
      username: 'sender_name',
      sentAt: new Date('2026-08-30T12:15:12.345Z'),
      text: 'part two'
    }).username).toBe('sender_name');
  });

  it('generates canonical, distinct UUID message identifiers', () => {
    const first = generateMessageId();
    const second = generateMessageId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(second).not.toBe(first);
  });

  it('uses the intrinsic UTC formatter instead of a Date instance override', () => {
    const sentAt = new Date('2026-08-30T12:15:12.345Z');
    sentAt.toISOString = () => 'not-utc';

    expect(createManagedMessageEnvelope({
      id: MESSAGE_ID,
      i: 1,
      n: 1,
      uid: 1,
      sentAt,
      text: 'x'
    }).ts).toBe('2026-08-30T12:15:12.345Z');
  });

  it.each([
    [{ id: 'not-a-uuid', i: 1, n: 1, uid: 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID.toUpperCase(), i: 1, n: 1, uid: 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 0, n: 1, uid: 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 1.5, n: 2, uid: 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 2, n: 1, uid: 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 1, n: 1.5, uid: 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 1, n: 1, uid: 0, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 1, n: 1, uid: Number.MAX_SAFE_INTEGER + 1, sentAt: new Date(), text: 'x' }],
    [{ id: MESSAGE_ID, i: 1, n: 1, uid: 1, sentAt: new Date(Number.NaN), text: 'x' }]
  ])('rejects an invalid managed-message envelope input: %j', (input) => {
    expect(() => createManagedMessageEnvelope(input)).toThrow(InvalidManagedMessageError);
  });

  it.each([
    { id: MESSAGE_ID, i: 1, n: 1, uid: 1, sentAt: new Date(), text: 7 },
    { id: MESSAGE_ID, i: 1, n: 1, uid: 1, username: 7, sentAt: new Date(), text: 'x' },
    { id: MESSAGE_ID, i: 1, n: 1, uid: 1, sentAt: '2026-08-30T12:15:12.345Z', text: 'x' }
  ])('rejects runtime input that bypasses its TypeScript contract: %j', (input) => {
    expect(() => createManagedMessageEnvelope(input as unknown as CreateManagedMessageEnvelopeInput))
      .toThrow(InvalidManagedMessageError);
  });
});

import { describe, expect, it } from 'vitest';
import {
  InvalidManagedMessageError,
  createManagedMessageEnvelope,
  type ManagedMessageEnvelope
} from '../src/domain/managed-message';
import {
  MANAGED_MESSAGE_PREFIX,
  decodeManagedMessage,
  encodeManagedMessage
} from '../src/domain/managed-message-codec';

const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174000';
const ENVELOPE = createManagedMessageEnvelope({
  id: MESSAGE_ID,
  i: 1,
  n: 1,
  uid: 4_503_599_627_370_495,
  sentAt: new Date('2026-08-30T15:45:12.345+03:30'),
  text: 'سلام 👋 "quoted" \\ mixed'
});
const GOLDEN_WIRE = 'tgdn1:eyJ2IjoxLCJpZCI6IjEyM2U0NTY3LWU4OWItNDJkMy1hNDU2LTQyNjYxNDE3NDAwMCIsImkiOjEsIm4iOjEsInVpZCI6NDUwMzU5OTYyNzM3MDQ5NSwidXNlcm5hbWUiOm51bGwsInRzIjoiMjAyNi0wOC0zMFQxMjoxNToxMi4zNDVaIiwidGV4dCI6Itiz2YTYp9mFIPCfkYsgXCJxdW90ZWRcIiBcXCBtaXhlZCJ9';

describe('encodeManagedMessage', () => {
  it('matches the independent version-one golden vector exactly', () => {
    expect(MANAGED_MESSAGE_PREFIX).toBe('tgdn1:');
    expect(encodeManagedMessage(ENVELOPE)).toBe(GOLDEN_WIRE);
  });

  it('uses canonical JSON key order and Base64URL without padding', () => {
    const wire = encodeManagedMessage(ENVELOPE);
    const payload = wire.slice(MANAGED_MESSAGE_PREFIX.length);
    const json = new TextDecoder().decode(decodeBase64UrlForTest(payload));

    expect(json).toBe('{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":4503599627370495,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"سلام 👋 \\"quoted\\" \\\\ mixed"}');
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(wire).not.toContain('=');
    expect(encodeManagedMessage(ENVELOPE)).toBe(wire);
  });

  it('rejects a runtime-invalid envelope instead of emitting malformed wire', () => {
    const invalid = { ...ENVELOPE, i: 2, n: 1 } as ManagedMessageEnvelope;

    expect(() => encodeManagedMessage(invalid)).toThrow(InvalidManagedMessageError);
  });
});

describe('decodeManagedMessage', () => {
  it.each([
    ['Persian, emoji, quotes, backslashes, and absent username', ENVELOPE],
    ['mixed text and present username', createManagedMessageEnvelope({
      id: '018f47e2-8d52-7b3a-9c1e-96f82736c923',
      i: 2,
      n: 3,
      uid: 9_007_199_254_740_991,
      username: 'کاربر_name',
      sentAt: new Date('2026-01-01T00:00:00.000Z'),
      text: 'English فارسی 😀 " \\ \n'
    })]
  ])('round-trips %s without changing metadata or text', (_name, envelope) => {
    const wire = encodeManagedMessage(envelope);

    const result = decodeManagedMessage(wire);
    expect(result).toEqual({ status: 'valid', envelope });
    if (result.status === 'valid') expect(Object.isFrozen(result.envelope)).toBe(true);
  });

  it.each([
    ['raw TXT', { status: 'error', error: 'invalid_format' }],
    ['tgdn:abc', { status: 'error', error: 'invalid_format' }],
    ['tgdnx:abc', { status: 'error', error: 'invalid_format' }]
  ])('classifies an unknown managed-message format: %s', (wire, expected) => {
    expect(decodeManagedMessage(wire)).toEqual(expected);
  });

  it('classifies a non-string runtime value instead of throwing', () => {
    expect(decodeManagedMessage(null as unknown as string)).toEqual({
      status: 'error', error: 'invalid_format'
    });
  });

  it.each(['tgdn2:abc', 'tgdn999:abc'])('classifies an unknown prefix version: %s', (wire) => {
    expect(decodeManagedMessage(wire)).toEqual({ status: 'error', error: 'unsupported_version' });
  });

  it('classifies an unknown JSON payload version', () => {
    const json = '{"v":2,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}';

    expect(decodeManagedMessage(`tgdn1:${encodeAsciiJson(json)}`)).toEqual({
      status: 'error', error: 'unsupported_version'
    });
  });

  it.each(['tgdn1:', 'tgdn1:abcde', 'tgdn1:ab+c', 'tgdn1:YWJj=', 'tgdn1:YW Jj'])(
    'classifies malformed or non-contract Base64URL: %s',
    (wire) => {
      expect(decodeManagedMessage(wire)).toEqual({ status: 'error', error: 'invalid_encoding' });
    }
  );

  it('classifies bytes that are not valid UTF-8', () => {
    expect(decodeManagedMessage('tgdn1:_w')).toEqual({ status: 'error', error: 'invalid_utf8' });
  });

  it('classifies a payload that is not JSON', () => {
    expect(decodeManagedMessage(`tgdn1:${encodeAsciiJson('not-json')}`)).toEqual({
      status: 'error', error: 'invalid_json'
    });
  });

  it.each([
    '[]',
    '{"v":1}',
    '{"v":1,"id":"not-a-uuid","i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1.5,"n":2,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":2,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":9007199254740992,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":1,"username":9,"ts":"2026-08-30T12:15:12.345Z","text":"x"}',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T15:45:12.345+03:30","text":"x"}',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x","extra":true}'
  ])('classifies an invalid envelope without returning partial data: %s', (json) => {
    expect(decodeManagedMessage(`tgdn1:${encodeAsciiJson(json)}`)).toEqual({
      status: 'error', error: 'invalid_envelope'
    });
  });

  it.each([
    '{"id":"123e4567-e89b-42d3-a456-426614174000","v":1,"i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x"}',
    '{ "v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"x" }',
    '{"v":1,"id":"123e4567-e89b-42d3-a456-426614174000","i":1,"n":1,"uid":1,"username":null,"ts":"2026-08-30T12:15:12.345Z","text":"\\u0641\\u0627\\u0631\\u0633\\u06cc"}'
  ])('rejects a valid but non-canonical JSON representation: %s', (json) => {
    expect(decodeManagedMessage(`tgdn1:${encodeAsciiJson(json)}`)).toEqual({
      status: 'error', error: 'non_canonical'
    });
  });
});

function encodeAsciiJson(json: string): string {
  return btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64UrlForTest(payload: string): Uint8Array {
  const padded = payload.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - payload.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

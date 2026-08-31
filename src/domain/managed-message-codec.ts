import {
  MANAGED_MESSAGE_VERSION,
  assertManagedMessageEnvelope,
  parseManagedMessageEnvelope,
  type ManagedMessageEnvelope
} from './managed-message';

export const MANAGED_MESSAGE_PREFIX = 'tgdn1:';

export type ManagedMessageDecodeError =
  | 'invalid_format'
  | 'unsupported_version'
  | 'invalid_encoding'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_envelope'
  | 'non_canonical';

export type ManagedMessageDecodeResult =
  | { readonly status: 'valid'; readonly envelope: ManagedMessageEnvelope }
  | { readonly status: 'error'; readonly error: ManagedMessageDecodeError };

const VERSIONED_PREFIX = /^tgdn(\d+):/u;
const BASE64URL_WITHOUT_PADDING = /^[A-Za-z0-9_-]+$/u;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeManagedMessage(envelope: ManagedMessageEnvelope): string {
  assertManagedMessageEnvelope(envelope);
  const canonicalJson = JSON.stringify({
    v: envelope.v,
    id: envelope.id,
    i: envelope.i,
    n: envelope.n,
    uid: envelope.uid,
    username: envelope.username,
    ts: envelope.ts,
    text: envelope.text
  });
  return `${MANAGED_MESSAGE_PREFIX}${encodeBase64Url(textEncoder.encode(canonicalJson))}`;
}

export function decodeManagedMessage(wire: string): ManagedMessageDecodeResult {
  if (typeof wire !== 'string') return error('invalid_format');
  if (!wire.startsWith(MANAGED_MESSAGE_PREFIX)) {
    const versionMatch = VERSIONED_PREFIX.exec(wire);
    return versionMatch === null
      ? error('invalid_format')
      : error('unsupported_version');
  }

  const payload = wire.slice(MANAGED_MESSAGE_PREFIX.length);
  const bytes = decodeBase64Url(payload);
  if (bytes === null) return error('invalid_encoding');

  let json: string;
  try {
    json = fatalTextDecoder.decode(bytes);
  } catch {
    return error('invalid_utf8');
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return error('invalid_json');
  }

  if (isRecord(value) && typeof value.v === 'number' && value.v !== MANAGED_MESSAGE_VERSION) {
    return error('unsupported_version');
  }

  const envelope = parseManagedMessageEnvelope(value);
  if (envelope === null) return error('invalid_envelope');
  if (encodeManagedMessage(envelope) !== wire) return error('non_canonical');
  return { status: 'valid', envelope };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(payload: string): Uint8Array | null {
  if (!BASE64URL_WITHOUT_PADDING.test(payload) || payload.length % 4 === 1) return null;

  const standard = payload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - standard.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return encodeBase64Url(bytes) === payload ? bytes : null;
}

function error(errorCode: ManagedMessageDecodeError): ManagedMessageDecodeResult {
  return { status: 'error', error: errorCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

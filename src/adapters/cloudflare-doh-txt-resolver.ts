import type { TxtRecord, TxtResolution, TxtResolverPort } from '../application/txt-resolver';
import { canonicalizeMailbox } from '../domain/mailbox';

const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const CNAME_TYPE = 5;
const TXT_TYPE = 16;
const NXDOMAIN_RESPONSE_CODE = 3;
const MAXIMUM_TXT_RDATA_BYTES = 65_535;
const MAXIMUM_DNS_TTL_SECONDS = 4_294_967_295;

export interface CloudflareDohTxtResolverOptions {
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMilliseconds?: number;
}

interface DnsAnswer {
  readonly name: string;
  readonly type: typeof CNAME_TYPE | typeof TXT_TYPE;
  readonly ttl: number;
  readonly data: string;
}

export class CloudflareDohTxtResolver implements TxtResolverPort {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #timeoutMilliseconds: number;

  constructor(options: CloudflareDohTxtResolverOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#endpoint = validateEndpoint(options.endpoint ?? DEFAULT_DOH_ENDPOINT);
    this.#timeoutMilliseconds = positiveTimeout(options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS);
  }

  async resolveTxt(name: string): Promise<TxtResolution> {
    const canonicalName = canonicalizeMailbox(name);
    if (canonicalName === null || canonicalName !== name) return { status: 'invalid_response' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    let responseReceived = false;
    try {
      const url = new URL(this.#endpoint);
      url.searchParams.set('name', name);
      url.searchParams.set('type', 'TXT');
      const response = await this.#fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        signal: controller.signal
      });
      responseReceived = true;
      if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/dns-json') {
        return { status: 'invalid_response' };
      }
      return parseTxtResponse(await response.json() as unknown, name);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return { status: 'timeout' };
      return responseReceived ? { status: 'invalid_response' } : { status: 'network_error' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseTxtResponse(payload: unknown, expectedName: string): TxtResolution {
  if (!isRecord(payload) || !isDnsResponseCode(payload.Status) ||
      !isExpectedQuestion(payload.Question, expectedName)) {
    return { status: 'invalid_response' };
  }
  if (payload.Status === NXDOMAIN_RESPONSE_CODE) return { status: 'nxdomain' };
  if (payload.Status !== 0) return { status: 'dns_error', responseCode: payload.Status };

  const answers = parseAnswers(payload.Answer);
  if (answers === null) return { status: 'invalid_response' };
  return resolveAnswerChain(answers, expectedName);
}

function isExpectedQuestion(value: unknown, expectedName: string): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const question = value[0];
  return isRecord(question) && question.type === TXT_TYPE &&
    canonicalDnsName(question.name) === expectedName;
}

function parseAnswers(value: unknown): readonly DnsAnswer[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const answers: DnsAnswer[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || (candidate.type !== CNAME_TYPE && candidate.type !== TXT_TYPE) ||
        !Number.isSafeInteger(candidate.TTL) || typeof candidate.TTL !== 'number' || candidate.TTL < 0 ||
        candidate.TTL > MAXIMUM_DNS_TTL_SECONDS || typeof candidate.data !== 'string') {
      return null;
    }
    const name = canonicalDnsName(candidate.name);
    if (name === null) return null;
    answers.push({ name, type: candidate.type, ttl: candidate.TTL, data: candidate.data });
  }
  return answers;
}

function resolveAnswerChain(answers: readonly DnsAnswer[], expectedName: string): TxtResolution {
  const answersByOwner = new Map<string, DnsAnswer[]>();
  for (const answer of answers) {
    const ownerAnswers = answersByOwner.get(answer.name) ?? [];
    ownerAnswers.push(answer);
    answersByOwner.set(answer.name, ownerAnswers);
  }

  const visited = new Set<string>();
  let owner = expectedName;
  while (true) {
    if (visited.has(owner)) return { status: 'invalid_response' };
    visited.add(owner);
    const ownerAnswers = answersByOwner.get(owner) ?? [];
    const cnames = ownerAnswers.filter((answer) => answer.type === CNAME_TYPE);
    const txtRecords = ownerAnswers.filter((answer) => answer.type === TXT_TYPE);
    if (cnames.length > 1 || (cnames.length === 1 && txtRecords.length > 0)) {
      return { status: 'invalid_response' };
    }
    if (cnames.length === 0) {
      if ([...answersByOwner.keys()].some((answerOwner) => !visited.has(answerOwner))) {
        return { status: 'invalid_response' };
      }
      return parseTxtRecords(txtRecords);
    }
    const target = canonicalDnsName(cnames[0]!.data);
    if (target === null) return { status: 'invalid_response' };
    owner = target;
  }
}

function parseTxtRecords(answers: readonly DnsAnswer[]): TxtResolution {
  if (answers.length === 0) return { status: 'nodata' };
  const records: TxtRecord[] = [];
  for (const answer of answers) {
    const value = parseTxtPresentation(answer.data);
    if (value === null) return { status: 'invalid_response' };
    records.push({ name: answer.name, ttl: answer.ttl, value });
  }
  return { status: 'found', records };
}

function parseTxtPresentation(data: string): string | null {
  const bytes: number[] = [];
  let index = 0;
  let segments = 0;
  while (index < data.length) {
    while (index < data.length && isAsciiWhitespace(data[index]!)) index += 1;
    if (index === data.length) break;
    if (data[index] !== '"') return null;
    index += 1;
    let closed = false;
    let segmentBytes = 0;
    while (index < data.length) {
      const character = data[index]!;
      if (character === '"') {
        closed = true;
        index += 1;
        break;
      }
      let encoded: Uint8Array;
      if (character === '\\') {
        index += 1;
        if (index === data.length) return null;
        if (/[0-9]/u.test(data[index]!)) {
          const escape = data.slice(index, index + 3);
          if (!/^[0-9]{3}$/u.test(escape)) return null;
          const octet = Number(escape);
          if (octet > 255) return null;
          encoded = new Uint8Array([octet]);
          index += 3;
        } else {
          const escaped = codePointAt(data, index);
          if (escaped === null) return null;
          encoded = new TextEncoder().encode(escaped.value);
          index = escaped.nextIndex;
        }
      } else {
        const literal = codePointAt(data, index);
        if (literal === null) return null;
        encoded = new TextEncoder().encode(literal.value);
        index = literal.nextIndex;
      }
      segmentBytes += encoded.length;
      if (segmentBytes > 255 || bytes.length + encoded.length + segments + 1 > MAXIMUM_TXT_RDATA_BYTES) {
        return null;
      }
      bytes.push(...encoded);
    }
    if (!closed) return null;
    segments += 1;
    if (index < data.length && !isAsciiWhitespace(data[index]!)) return null;
  }
  if (segments === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function canonicalDnsName(value: unknown): string | null {
  return typeof value === 'string' ? canonicalizeMailbox(value) : null;
}

function codePointAt(input: string, index: number): { readonly value: string; readonly nextIndex: number } | null {
  const codePoint = input.codePointAt(index);
  if (codePoint === undefined) return null;
  const value = String.fromCodePoint(codePoint);
  return { value, nextIndex: index + value.length };
}

function isAsciiWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function isDnsResponseCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 15;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function validateEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' || endpoint.username.length > 0 || endpoint.password.length > 0 ||
      endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw new TypeError('Invalid DoH endpoint');
  }
  return endpoint.toString();
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid DoH timeout');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

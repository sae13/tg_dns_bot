import {
  RecordStoreError,
  type DeleteTxtRecordsResult,
  type NumberedTxtInventoryResult,
  type ReadExactTxtResult,
  type RecordStorePort,
  type ReplaceSingleTxtRequest,
  type ReplaceSingleTxtResult,
  type TxtRecordRequest
} from '../application/record-store';
import {
  canonicalizeMailbox,
  resolveMailbox,
  type AllowedZoneMap
} from '../domain/mailbox';
import {
  TXT_CHARACTER_STRING_BYTE_LIMIT,
  TXT_RECORD_WIRE_BYTE_LIMIT
} from '../domain/publish-plan';

const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const MINIMUM_DNS_TTL_SECONDS = 30;
const MAXIMUM_DNS_TTL_SECONDS = 86_400;
const LIST_PAGE_SIZE = 100;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]+$/u;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_BUDGET_MILLISECONDS = 45_000;
const RETRY_DELAYS_MILLISECONDS = [2_000, 4_000] as const;
const textEncoder = new TextEncoder();

export type CloudflareFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface CloudflareOperationLog {
  readonly correlationId: string;
  readonly operation: string;
  readonly durationMilliseconds: number;
  readonly outcome: 'success' | 'retry' | 'failure';
  readonly errorType?: string;
}

export interface CloudflareRecordStoreOptions {
  readonly apiToken: string;
  readonly allowedZones: AllowedZoneMap;
  readonly fetcher?: CloudflareFetch;
  readonly apiBaseUrl?: string;
  readonly correlationId?: string;
  readonly timeoutMilliseconds?: number;
  readonly budgetMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: (event: CloudflareOperationLog) => void;
}

interface CloudflareRecord {
  readonly id: string;
  readonly type: 'TXT';
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
}

interface ListResult {
  readonly records: readonly CloudflareRecord[];
}

interface ExpectedTxtRecord {
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
}

interface ValidatedReplaceSingleTxtRequest extends ReplaceSingleTxtRequest {
  readonly content: string;
}

interface TxtRecordBody extends ExpectedTxtRecord {
  readonly type: 'TXT';
}

type MutationExpectation =
  | (ExpectedTxtRecord & { readonly kind: 'single'; readonly recordId: string | null })
  | (ExpectedTxtRecord & { readonly kind: 'batch'; readonly deletedRecordIds: readonly string[] });

const NUMBERED_LABEL = /^(?:[2-9]|[1-9][0-9]+)$/u;

export class CloudflareRecordStoreAdapter implements RecordStorePort {
  readonly #apiToken: string;
  readonly #allowedZones: AllowedZoneMap;
  readonly #fetcher: CloudflareFetch;
  readonly #apiBaseUrl: string;
  readonly #correlationId: string;
  readonly #timeoutMilliseconds: number;
  readonly #budgetMilliseconds: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #logger: (event: CloudflareOperationLog) => void;
  readonly #budgetStartedAt: number;

  constructor(options: CloudflareRecordStoreOptions) {
    this.#apiToken = validateApiToken(options.apiToken);
    this.#allowedZones = options.allowedZones;
    this.#fetcher = options.fetcher ?? fetch;
    this.#apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#correlationId = options.correlationId ?? crypto.randomUUID();
    this.#timeoutMilliseconds = positiveMilliseconds(
      options.timeoutMilliseconds,
      DEFAULT_TIMEOUT_MILLISECONDS
    );
    this.#budgetMilliseconds = positiveMilliseconds(
      options.budgetMilliseconds,
      DEFAULT_BUDGET_MILLISECONDS
    );
    this.#maxAttempts = positiveAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.#logger = options.logger ?? ((event) => { console.info('cloudflare_operation', event); });
    this.#budgetStartedAt = this.#now();
  }

  async appendSingleTxt(
    request: TxtRecordRequest
  ): Promise<{ readonly status: 'created'; readonly recordId: string }> {
    const validated = validateRequest(request, this.#allowedZones);
    const body = createTxtRecordBody(validated);
    const record = await this.#mutate(
      this.#zoneRecordsUrl(validated.zoneId),
      'POST',
      body,
      { kind: 'single', ...body, recordId: null }
    );
    return { status: 'created', recordId: record.id };
  }

  async readExactTxtRecords(
    request: Pick<TxtRecordRequest, 'zoneId' | 'name'>
  ): Promise<ReadExactTxtResult> {
    const validated = validateTarget(request, this.#allowedZones);
    const records = (await this.#listExactTxtRecords(validated.zoneId, validated.name)).records;
    if (records.length === 0) return { status: 'not_found' };
    return {
      status: 'found',
      records: Object.freeze(records.map((record) => ({
        recordId: record.id,
        wire: parseTxtContent(record.content)
      })))
    };
  }

  async listNumberedTxtRecords(
    request: { readonly zoneId: string; readonly rootName: string }
  ): Promise<NumberedTxtInventoryResult> {
    const validated = validateTarget(
      { zoneId: request.zoneId, name: request.rootName },
      this.#allowedZones
    );
    const records = await this.#listTxtRecordsBySuffix(validated.zoneId, validated.name);
    const names = [...new Set(records
      .map(({ name }) => name)
      .filter((name) => isNumberedName(name, validated.name)))]
      .sort(compareNumberedNames);
    return names.length === 0
      ? { status: 'not_found' }
      : { status: 'found', names: Object.freeze(names) };
  }

  async deleteTxtRecords(
    request: Pick<TxtRecordRequest, 'zoneId' | 'name'>
  ): Promise<DeleteTxtRecordsResult> {
    const validated = validateTarget(request, this.#allowedZones);
    const records = (await this.#listExactTxtRecords(validated.zoneId, validated.name)).records;
    if (records.length === 0) return { status: 'not_found' };
    await this.#deleteBatch(validated.zoneId, records.map(({ id }) => id));
    return { status: 'deleted' };
  }

  async replaceWithSingleTxt(request: ReplaceSingleTxtRequest): Promise<ReplaceSingleTxtResult> {
    const validated = validateRequest(request, this.#allowedZones);
    const records = (await this.#listExactTxtRecords(validated.zoneId, validated.name)).records;
    const body = createTxtRecordBody(validated);

    if (records.length === 0) {
      const record = await this.#mutate(
        `${this.#zoneRecordsUrl(validated.zoneId)}`,
        'POST',
        body,
        { kind: 'single', ...body, recordId: null }
      );
      return { status: 'created', recordId: record.id };
    }

    if (records.length === 1) {
      const record = await this.#mutate(
        `${this.#zoneRecordsUrl(validated.zoneId)}/${records[0]!.id}`,
        'PUT',
        body,
        { kind: 'single', ...body, recordId: records[0]!.id }
      );
      return { status: 'updated', recordId: record.id };
    }

    const record = await this.#mutate(
      `${this.#zoneRecordsUrl(validated.zoneId)}/batch`,
      'POST',
      {
        deletes: records.map(({ id }) => ({ id })),
        posts: [body]
      },
      { kind: 'batch', ...body, deletedRecordIds: records.map(({ id }) => id) }
    );
    return { status: 'updated', recordId: record.id };
  }

  async #listExactTxtRecords(zoneId: string, name: string): Promise<ListResult> {
    const url = new URL(this.#zoneRecordsUrl(zoneId));
    url.searchParams.set('type', 'TXT');
    url.searchParams.set('name.exact', name);
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', String(LIST_PAGE_SIZE));

    const response = await this.#fetchWithRetry('read_exact', url.toString(), {
      method: 'GET',
      headers: this.#headers(false)
    }, false);
    const envelope = await readJson(response, 'provider_response');
    if (!isSuccessfulEnvelope(envelope) || !Array.isArray(envelope.result)) {
      throw new RecordStoreError('provider_response');
    }
    if (!isCompleteSinglePage(envelope.result_info, envelope.result.length)) {
      throw new RecordStoreError('ambiguous_result');
    }

    const records = parseRecordList(envelope.result, name);
    return { records };
  }

  async #listTxtRecordsBySuffix(zoneId: string, suffix: string): Promise<readonly CloudflareRecord[]> {
    const records: CloudflareRecord[] = [];
    const identifiers = new Set<string>();
    let page = 1;
    let expectedTotalPages: number | null = null;

    do {
      const url = new URL(this.#zoneRecordsUrl(zoneId));
      url.searchParams.set('type', 'TXT');
      url.searchParams.set('name.endswith', suffix);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', String(LIST_PAGE_SIZE));
      const envelope = await this.#getEnvelope(url);
      if (!Array.isArray(envelope.result) || !isRecord(envelope.result_info)) {
        throw new RecordStoreError('provider_response');
      }
      const totalPages = parsePageInfo(envelope.result_info, page, envelope.result.length);
      if (expectedTotalPages !== null && totalPages !== expectedTotalPages) {
        throw new RecordStoreError('ambiguous_result');
      }
      expectedTotalPages = totalPages;
      for (const entry of envelope.result) {
        const record = parseCloudflareRecord(entry);
        if (record === null || identifiers.has(record.id)) {
          throw new RecordStoreError('provider_response');
        }
        identifiers.add(record.id);
        records.push(record);
      }
      page += 1;
    } while (expectedTotalPages !== null && page <= expectedTotalPages);

    return records;
  }

  async #getEnvelope(url: URL): Promise<Record<string, unknown>> {
    const response = await this.#fetchWithRetry('read_inventory', url.toString(), {
      method: 'GET',
      headers: this.#headers(false)
    }, false);
    const envelope = await readJson(response, 'provider_response');
    if (!isSuccessfulEnvelope(envelope)) throw new RecordStoreError('provider_response');
    return envelope;
  }

  async #deleteBatch(zoneId: string, recordIds: readonly string[]): Promise<void> {
    const response = await this.#mutationResponse(
      `${this.#zoneRecordsUrl(zoneId)}/batch`,
      'POST',
      { deletes: recordIds.map((id) => ({ id })) }
    );
    if (!isRecord(response.result) || !Array.isArray(response.result.deletes) ||
        response.result.deletes.length !== recordIds.length) {
      throw new RecordStoreError('unknown_result');
    }
    const deletedIds = response.result.deletes.map(parseRecordId);
    if (deletedIds.some((id) => id === null) || new Set(deletedIds).size !== recordIds.length ||
        recordIds.some((id) => !deletedIds.includes(id))) {
      throw new RecordStoreError('unknown_result');
    }
  }

  async #mutationResponse(
    url: string,
    method: 'POST' | 'PUT',
    body: unknown
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetchWithRetry('mutation', url, {
      method,
      headers: this.#headers(true),
      body: JSON.stringify(body)
    }, true);
    const envelope = await readJson(response, 'unknown_result');
    if (!isSuccessfulEnvelope(envelope)) throw new RecordStoreError('unknown_result');
    return envelope;
  }

  async #mutate(
    url: string,
    method: 'POST' | 'PUT',
    body: unknown,
    expectation: MutationExpectation
  ): Promise<CloudflareRecord> {
    const envelope = await this.#mutationResponse(url, method, body);
    const record = expectation.kind === 'single'
      ? parseMutationRecord(envelope.result, expectation)
      : parseBatchMutationRecord(envelope.result, expectation);
    if (record === null) throw new RecordStoreError('unknown_result');
    return record;
  }

  async #fetchWithRetry(
    operation: string,
    input: RequestInfo | URL,
    init: RequestInit,
    mutation: boolean
  ): Promise<Response> {
    let lastCode: 'provider_unavailable' | 'provider_error' | 'unknown_result' = mutation
      ? 'unknown_result'
      : 'provider_unavailable';
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const startedAt = this.#now();
      const budgetRemaining = this.#budgetMilliseconds - (startedAt - this.#budgetStartedAt);
      if (budgetRemaining <= 0) throw new RecordStoreError('budget_exhausted');
      const controller = new AbortController();
      const timeout = Math.min(this.#timeoutMilliseconds, budgetRemaining);
      const timeoutId = setTimeout(() => { controller.abort(); }, timeout);
      timeoutId.unref?.();
      try {
        const response = await this.#fetcher(input, { ...init, signal: controller.signal });
        if (response.ok) {
          this.#log(operation, startedAt, 'success');
          return response;
        }
        if (!isTransientStatus(response.status)) {
          this.#log(operation, startedAt, 'failure', 'provider_error');
          throw new RecordStoreError('provider_error');
        }
        lastCode = mutation ? 'unknown_result' : 'provider_unavailable';
        if (mutation && response.status !== 429) {
          this.#log(operation, startedAt, 'failure', lastCode);
          throw new RecordStoreError(lastCode);
        }
      } catch (error) {
        if (error instanceof RecordStoreError) throw error;
        lastCode = mutation ? 'unknown_result' : 'provider_unavailable';
        if (mutation) {
          this.#log(operation, startedAt, 'failure', lastCode);
          throw new RecordStoreError(lastCode);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      if (attempt >= this.#maxAttempts) break;
      const baseDelay = RETRY_DELAYS_MILLISECONDS[attempt - 1] ?? RETRY_DELAYS_MILLISECONDS.at(-1)!;
      const delay = Math.round(baseDelay * (1 + this.#random()));
      if (this.#now() - this.#budgetStartedAt + delay >= this.#budgetMilliseconds) {
        throw new RecordStoreError('budget_exhausted');
      }
      this.#log(operation, startedAt, 'retry', lastCode);
      await this.#sleep(delay);
    }
    this.#logger({
      correlationId: this.#correlationId,
      operation,
      durationMilliseconds: Math.max(0, this.#now() - this.#budgetStartedAt),
      outcome: 'failure',
      errorType: lastCode
    });
    throw new RecordStoreError(lastCode);
  }

  #log(
    operation: string,
    startedAt: number,
    outcome: CloudflareOperationLog['outcome'],
    errorType?: string
  ): void {
    this.#logger({
      correlationId: this.#correlationId,
      operation,
      durationMilliseconds: Math.max(0, this.#now() - startedAt),
      outcome,
      ...(errorType === undefined ? {} : { errorType })
    });
  }

  #zoneRecordsUrl(zoneId: string): string {
    return `${this.#apiBaseUrl}/zones/${zoneId}/dns_records`;
  }

  #headers(includeContentType: boolean): Headers {
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.#apiToken}`
    });
    if (includeContentType) headers.set('content-type', 'application/json');
    return headers;
  }
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RecordStoreError('invalid_configuration');
  }
  return resolved;
}

function positiveAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_ATTEMPTS) {
    throw new RecordStoreError('invalid_configuration');
  }
  return value;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function validateApiToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\s/u.test(value)) {
    throw new RecordStoreError('invalid_configuration');
  }
  return value;
}

function validateApiBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new RecordStoreError('invalid_configuration');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RecordStoreError('invalid_configuration');
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 ||
      url.search.length > 0 || url.hash.length > 0) {
    throw new RecordStoreError('invalid_configuration');
  }
  return url.toString().replace(/\/$/u, '');
}

function validateTarget(
  request: Pick<TxtRecordRequest, 'zoneId' | 'name'>,
  allowedZones: AllowedZoneMap
): { readonly zoneId: string; readonly name: string } {
  if (!isRecord(request) || typeof request.name !== 'string' || typeof request.zoneId !== 'string' ||
      canonicalizeMailbox(request.name) !== request.name || !SAFE_PROVIDER_ID.test(request.zoneId)) {
    throw new RecordStoreError('unsafe_target');
  }
  const target = resolveMailbox(request.name, allowedZones);
  if (target === null || target.zoneId !== request.zoneId) {
    throw new RecordStoreError('unsafe_target');
  }
  return { zoneId: request.zoneId, name: request.name };
}

function validateRequest(
  request: ReplaceSingleTxtRequest,
  allowedZones: AllowedZoneMap
): ValidatedReplaceSingleTxtRequest {
  const target = validateTarget(request, allowedZones);
  if (!Number.isInteger(request.ttl) ||
      (request.ttl !== 1 && (request.ttl < MINIMUM_DNS_TTL_SECONDS || request.ttl > MAXIMUM_DNS_TTL_SECONDS)) ||
      !Array.isArray(request.characterStrings) ||
      request.characterStrings.length === 0) {
    throw new RecordStoreError('invalid_request');
  }

  let aggregateByteLength = 0;
  for (const characterString of request.characterStrings) {
    if (typeof characterString !== 'string') throw new RecordStoreError('invalid_request');
    const byteLength = textEncoder.encode(characterString).length;
    if (byteLength > TXT_CHARACTER_STRING_BYTE_LIMIT) throw new RecordStoreError('invalid_request');
    aggregateByteLength += byteLength;
  }
  if (aggregateByteLength > TXT_RECORD_WIRE_BYTE_LIMIT) {
    throw new RecordStoreError('invalid_request');
  }

  return {
    zoneId: target.zoneId,
    name: target.name,
    ttl: request.ttl,
    characterStrings: request.characterStrings,
    content: request.characterStrings.map(quoteCharacterString).join(' ')
  };
}

function quoteCharacterString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function createTxtRecordBody(request: ValidatedReplaceSingleTxtRequest): TxtRecordBody {
  return {
    type: 'TXT',
    name: request.name,
    content: request.content,
    ttl: request.ttl
  };
}

function parseRecordList(value: readonly unknown[], expectedName: string): readonly CloudflareRecord[] {
  const records: CloudflareRecord[] = [];
  const identifiers = new Set<string>();
  for (const entry of value) {
    const record = parseCloudflareRecord(entry);
    if (record === null || record.type !== 'TXT' || record.name !== expectedName || identifiers.has(record.id)) {
      throw new RecordStoreError('provider_response');
    }
    identifiers.add(record.id);
    records.push(record);
  }
  return records;
}

function parseMutationRecord(
  value: unknown,
  expectation: Extract<MutationExpectation, { readonly kind: 'single' }>
): CloudflareRecord | null {
  const record = parseCloudflareRecord(value);
  if (!matchesExpectedRecord(record, expectation) ||
      (expectation.recordId !== null && record.id !== expectation.recordId)) {
    return null;
  }
  return record;
}

function parseBatchMutationRecord(
  value: unknown,
  expectation: Extract<MutationExpectation, { readonly kind: 'batch' }>
): CloudflareRecord | null {
  if (!isRecord(value) || !Array.isArray(value.deletes) || !Array.isArray(value.posts) ||
      value.posts.length !== 1 || value.deletes.length !== expectation.deletedRecordIds.length) {
    return null;
  }
  const deletedRecordIds = value.deletes.map(parseRecordId);
  if (deletedRecordIds.some((id) => id === null) ||
      new Set(deletedRecordIds).size !== expectation.deletedRecordIds.length ||
      expectation.deletedRecordIds.some((id) => !deletedRecordIds.includes(id))) {
    return null;
  }
  const record = parseCloudflareRecord(value.posts[0]);
  return matchesExpectedRecord(record, expectation) && !expectation.deletedRecordIds.includes(record.id)
    ? record
    : null;
}

function matchesExpectedRecord(
  record: CloudflareRecord | null,
  expected: ExpectedTxtRecord
): record is CloudflareRecord {
  return record !== null && record.name === expected.name && record.content === expected.content &&
    record.ttl === expected.ttl;
}

function parseRecordId(value: unknown): string | null {
  return isRecord(value) && typeof value.id === 'string' && SAFE_PROVIDER_ID.test(value.id)
    ? value.id
    : null;
}

function parseCloudflareRecord(value: unknown): CloudflareRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !SAFE_PROVIDER_ID.test(value.id) ||
      value.type !== 'TXT' || typeof value.name !== 'string' || typeof value.content !== 'string' ||
      typeof value.ttl !== 'number' || !Number.isInteger(value.ttl)) {
    return null;
  }
  return { id: value.id, type: value.type, name: value.name, content: value.content, ttl: value.ttl };
}

function isSuccessfulEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.success === true && Object.hasOwn(value, 'result');
}

function isCompleteSinglePage(value: unknown, resultCount: number): boolean {
  if (!isRecord(value)) return false;
  const fields = ['page', 'per_page', 'count', 'total_count', 'total_pages'] as const;
  if (fields.some((field) => !Number.isInteger(value[field]))) return false;
  return value.page === 1 && value.per_page === LIST_PAGE_SIZE && value.count === resultCount &&
    typeof value.total_count === 'number' && value.total_count >= resultCount && value.total_pages === 1;
}

function parsePageInfo(value: Record<string, unknown>, expectedPage: number, resultCount: number): number {
  const fields = ['page', 'per_page', 'count', 'total_count', 'total_pages'] as const;
  if (fields.some((field) => !Number.isInteger(value[field])) || value.page !== expectedPage ||
      value.per_page !== LIST_PAGE_SIZE || value.count !== resultCount ||
      typeof value.total_count !== 'number' || value.total_count < resultCount ||
      typeof value.total_pages !== 'number' || value.total_pages < 1 || expectedPage > value.total_pages) {
    throw new RecordStoreError('ambiguous_result');
  }
  return value.total_pages;
}

function parseTxtContent(content: string): string {
  let index = 0;
  let wire = '';
  let segments = 0;
  while (index < content.length) {
    while (content[index] === ' ') index += 1;
    if (content[index] !== '"') throw new RecordStoreError('provider_response');
    index += 1;
    let segment = '';
    let closed = false;
    while (index < content.length) {
      const character = content[index]!;
      index += 1;
      if (character === '"') {
        closed = true;
        break;
      }
      if (character === '\\') {
        if (index >= content.length) throw new RecordStoreError('provider_response');
        const escaped = content[index]!;
        if (escaped !== '\\' && escaped !== '"') throw new RecordStoreError('provider_response');
        segment += escaped;
        index += 1;
      } else {
        segment += character;
      }
    }
    if (!closed || textEncoder.encode(segment).length > TXT_CHARACTER_STRING_BYTE_LIMIT) {
      throw new RecordStoreError('provider_response');
    }
    wire += segment;
    segments += 1;
    if (index < content.length && content[index] !== ' ') throw new RecordStoreError('provider_response');
  }
  if (segments === 0 || textEncoder.encode(wire).length > TXT_RECORD_WIRE_BYTE_LIMIT) {
    throw new RecordStoreError('provider_response');
  }
  return wire;
}

function isNumberedName(name: string, rootName: string): boolean {
  if (!name.endsWith(`.${rootName}`)) return false;
  const prefix = name.slice(0, -(rootName.length + 1));
  return NUMBERED_LABEL.test(prefix);
}

function compareNumberedNames(left: string, right: string): number {
  return Number(left.slice(0, left.indexOf('.'))) - Number(right.slice(0, right.indexOf('.')));
}

async function readJson(
  response: Response,
  errorCode: 'provider_response' | 'unknown_result'
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new RecordStoreError(errorCode);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { TELEGRAM_MESSAGE_CHARACTER_LIMIT } from './telegram-inbox-renderer';

export type TelegramDeliveryFailureKind =
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'api_error';

export interface TelegramBotApiOptions {
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMilliseconds?: number;
  readonly logger?: TelegramDeliveryLogger;
}

export interface TelegramDeliveryLog {
  readonly correlationId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly outcome: 'failure';
  readonly errorType: TelegramDeliveryFailureKind;
}

export type TelegramDeliveryLogger = (event: TelegramDeliveryLog) => void;

export interface TelegramBotApiPort {
  sendChunks(
    chatId: number,
    chunks: readonly string[],
    correlationId?: string
  ): Promise<void>;
}

export class TelegramDeliveryError extends Error {
  readonly correlationId: string;
  readonly chunkIndex: number;
  readonly kind: TelegramDeliveryFailureKind;
  readonly errorType: TelegramDeliveryFailureKind;

  constructor(
    correlationId: string,
    chunkIndex: number,
    kind: TelegramDeliveryFailureKind
  ) {
    // Deliberately do not include the token, response body or message text.
    super(`Telegram delivery failed (correlation ${correlationId}, chunk ${chunkIndex})`);
    this.name = 'TelegramDeliveryError';
    this.correlationId = correlationId;
    this.chunkIndex = chunkIndex;
    this.kind = kind;
    this.errorType = kind;
  }
}

interface TelegramApiResponse {
  readonly ok: boolean;
  readonly result?: unknown;
}

const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const MAX_CORRELATION_ID_LENGTH = 256;

export class TelegramBotApiAdapter implements TelegramBotApiPort {
  readonly #botToken: string;
  readonly #apiBaseUrl: string;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMilliseconds: number;
  readonly #logger: TelegramDeliveryLogger | undefined;

  constructor(options: TelegramBotApiOptions) {
    this.#botToken = validateBotToken(options.botToken);
    this.#apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMilliseconds = validateTimeout(
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
    );
    this.#logger = options.logger;
  }

  async sendChunks(
    chatId: number,
    chunks: readonly string[],
    correlationId: string = crypto.randomUUID()
  ): Promise<void> {
    validateChatId(chatId);
    validateCorrelationId(correlationId);
    if (!Array.isArray(chunks) || chunks.length === 0 ||
        chunks.some((chunk) => typeof chunk !== 'string' || chunk.length === 0 ||
          Array.from(chunk).length > TELEGRAM_MESSAGE_CHARACTER_LIMIT)) {
      throw new TypeError('Invalid Telegram chunks');
    }

    // Await each request before issuing the next one; Telegram preserves the
    // user-visible order this way and the first failure is attributable.
    for (let index = 0; index < chunks.length; index += 1) {
      try {
        await this.#sendOne(chatId, chunks[index]!, index + 1, correlationId);
      } catch (error) {
        const deliveryError = error instanceof TelegramDeliveryError
          ? error
          : new TelegramDeliveryError(correlationId, index + 1, 'network_error');
        this.#logger?.({
          correlationId: deliveryError.correlationId,
          chunkIndex: deliveryError.chunkIndex,
          chunkCount: chunks.length,
          outcome: 'failure',
          errorType: deliveryError.errorType
        });
        throw deliveryError;
      }
    }
  }

  async #sendOne(
    chatId: number,
    text: string,
    chunkIndex: number,
    correlationId: string
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    try {
      const response = await this.#fetcher(this.#methodUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new TelegramDeliveryError(correlationId, chunkIndex, 'http_error');
      }

      let payload: unknown;
      try {
        payload = await response.json() as unknown;
      } catch {
        throw new TelegramDeliveryError(correlationId, chunkIndex, 'invalid_response');
      }
      if (!isTelegramApiResponse(payload) || payload.ok !== true || !isRecord(payload.result)) {
        throw new TelegramDeliveryError(
          correlationId,
          chunkIndex,
          payload !== null && typeof payload === 'object' && (payload as { ok?: unknown }).ok === false
            ? 'api_error'
            : 'invalid_response'
        );
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      throw new TelegramDeliveryError(correlationId, chunkIndex, 'network_error');
    } finally {
      clearTimeout(timeout);
    }
  }

  #methodUrl(): string {
    return `${this.#apiBaseUrl}/bot${this.#botToken}/sendMessage`;
  }
}

export function createTelegramBotApi(options: TelegramBotApiOptions): TelegramBotApiAdapter {
  return new TelegramBotApiAdapter(options);
}

function validateBotToken(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('Invalid Telegram bot token');
  }
  return value;
}

function validateApiBaseUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 || url.password.length > 0 ||
      url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError('Invalid Telegram API base URL');
  }
  return value.replace(/\/+$/u, '');
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid Telegram timeout');
  return value;
}

function validateCorrelationId(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CORRELATION_ID_LENGTH) {
    throw new TypeError('Invalid Telegram correlation id');
  }
}

function validateChatId(value: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) {
    throw new TypeError('Invalid Telegram chat id');
  }
}

function isTelegramApiResponse(value: unknown): value is TelegramApiResponse {
  return isRecord(value) && typeof value.ok === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

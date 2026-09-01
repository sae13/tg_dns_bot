import type { SendRequest, SendRequestPort } from '../application/handle-update';

const DEFAULT_TIMEOUT_MILLISECONDS = 25_000;

export interface ExternalWriterClientOptions {
  readonly endpoint: string;
  readonly sharedSecret: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export class ExternalWriterError extends Error {
  constructor() {
    super('External writer request failed');
    this.name = 'ExternalWriterError';
  }
}

export class ExternalWriterClient implements SendRequestPort {
  readonly #endpoint: string;
  readonly #sharedSecret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMilliseconds: number;

  constructor(options: ExternalWriterClientOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
      throw new TypeError('Invalid external writer endpoint');
    }
    if (!/^[A-Za-z0-9_-]{16,256}$/u.test(options.sharedSecret)) {
      throw new TypeError('Invalid external writer shared secret');
    }
    if (!Number.isSafeInteger(options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS) ||
        (options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS) <= 0) {
      throw new TypeError('Invalid external writer timeout');
    }
    this.#endpoint = endpoint.toString();
    this.#sharedSecret = options.sharedSecret;
    this.#fetch = options.fetcher ?? fetch;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  }

  async accept(request: SendRequest): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#sharedSecret}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          mailbox: request.mailbox,
          text: request.text,
          senderId: request.senderId,
          ...(request.senderUsername === undefined ? {} : { senderUsername: request.senderUsername })
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new ExternalWriterError();
      const body: unknown = await response.json();
      if (!isPublished(body)) throw new ExternalWriterError();
    } catch (error) {
      if (error instanceof ExternalWriterError) throw error;
      throw new ExternalWriterError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isPublished(value: unknown): value is { readonly status: 'published' } {
  return value !== null && typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).status === 'published';
}

import type { UpdateHandler } from '../application/handle-update';
import { ConfigurationError } from '../domain/errors';
import { parseTelegramUpdate } from '../domain/telegram-update';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const MAX_BODY_BYTES = 256 * 1024;
const HANDLER_TIMEOUT_MS = 20_000;

export async function handleTelegramWebhook(
  request: Request,
  expectedSecret: string,
  handler: UpdateHandler
): Promise<Response> {
  const suppliedSecret = request.headers.get(SECRET_HEADER);
  if (suppliedSecret === null || !(await constantTimeEqual(suppliedSecret, expectedSecret))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return json({ error: 'unsupported_media_type' }, 415);

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  let payload: unknown;
  try {
    const body = await readBodyLimited(request, MAX_BODY_BYTES);
    payload = JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json({ error: 'payload_too_large' }, 413);
    return json({ error: 'invalid_payload' }, 400);
  }

  const parsed = parseTelegramUpdate(payload);
  if (parsed.status === 'invalid') return json({ error: 'invalid_payload' }, 400);
  if (parsed.status === 'unsupported') return json({ ok: true, ignored: true }, 200);

  try {
    const result = await withTimeout(handler.handle(parsed.update), HANDLER_TIMEOUT_MS);
    return isTelegramWebhookMethod(result) ? json(result, 200) : json({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    console.error('Telegram update handling failed', {
      updateId: parsed.update.updateId,
      errorType: error instanceof HandlerTimeoutError ? 'timeout' : 'handler_error'
    });
    return json({ error: 'update_failed' }, 500);
  }
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right))
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index]! ^ b[index]!;
  return mismatch === 0;
}

class HandlerTimeoutError extends Error {}
class PayloadTooLargeError extends Error {}

async function readBodyLimited(request: Request, maxBytes: number): Promise<string> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new PayloadTooLargeError('payload too large');
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new HandlerTimeoutError('handler timeout')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function isTelegramWebhookMethod(result: unknown): result is Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as Record<string, unknown>;
  return candidate.method === 'sendMessage' &&
    typeof candidate.chat_id === 'number' &&
    Number.isSafeInteger(candidate.chat_id) &&
    typeof candidate.text === 'string';
}

function json(body: object, status: number): Response {
  return Response.json(body, { status });
}

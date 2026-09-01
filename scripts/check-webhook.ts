export {};

interface TelegramWebhookInfoResponse {
  readonly ok: boolean;
  readonly result?: {
    readonly url?: string;
    readonly pending_update_count?: number;
    readonly last_error_date?: number;
    readonly last_error_message?: string;
  };
}

async function main(): Promise<void> {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const expectedUrl = requireEnv('TELEGRAM_WEBHOOK_URL');
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
  const body = await parseResponse(response);
  if (!body.ok || body.result?.url !== expectedUrl) {
    throw new Error('Telegram webhook URL is not configured as expected');
  }

  const pendingUpdateCount = body.result.pending_update_count;
  const lastErrorDate = body.result.last_error_date;
  const lastErrorMessage = body.result.last_error_message;
  const hasLastError = typeof lastErrorDate === 'number' ||
    (typeof lastErrorMessage === 'string' && lastErrorMessage.length > 0);

  console.log(`Webhook URL verified: true`);
  console.log(`Pending updates: ${pendingUpdateCount ?? 'unknown'}`);
  console.log(`Delivery error reported: ${hasLastError}`);
  if (lastErrorDate !== undefined) console.log(`Last delivery error date: ${lastErrorDate}`);
  if (lastErrorMessage !== undefined) console.log(`Last delivery error: ${sanitizeError(lastErrorMessage)}`);
  if (hasLastError) process.exitCode = 2;
}

function sanitizeError(value: string): string {
  const singleLine = value.replace(/[\r\n]+/gu, ' ').trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine;
}

async function parseResponse(response: Response): Promise<TelegramWebhookInfoResponse> {
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
      throw new Error('invalid shape');
    }
    return value as TelegramWebhookInfoResponse;
  } catch {
    throw new Error('Telegram returned an invalid JSON response');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Telegram webhook inspection failed');
  process.exitCode = 1;
});

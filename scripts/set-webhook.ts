interface TelegramResult {
  ok: boolean;
  description?: string;
  result?: { url?: string } | boolean;
}

export async function registerWebhook(options: {
  botToken: string;
  webhookSecret: string;
  webhookUrl: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  validateOptions(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const methodUrl = `${apiBaseUrl}/bot${options.botToken}/setWebhook`;
  const response = await safeFetch(fetchImpl, methodUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: options.webhookUrl, secret_token: options.webhookSecret })
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
  const result = await parseTelegramResponse(response);
  if (!result.ok || result.result !== true) throw new Error('Telegram webhook registration failed');

  const infoResponse = await safeFetch(fetchImpl, `${apiBaseUrl}/bot${options.botToken}/getWebhookInfo`);
  if (!infoResponse.ok) throw new Error(`Telegram returned HTTP ${infoResponse.status}`);
  const info = await parseTelegramResponse(infoResponse);
  if (!info.ok || info.result === null || typeof info.result !== 'object' || info.result.url !== options.webhookUrl) {
    throw new Error('Telegram webhook verification failed');
  }
}

function validateOptions(options: { botToken: string; webhookSecret: string; webhookUrl: string; apiBaseUrl?: string }): void {
  if (options.botToken.length === 0) throw new Error('Invalid bot token');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.webhookSecret)) throw new Error('Invalid webhook secret');
  const webhookUrl = new URL(options.webhookUrl);
  if (webhookUrl.protocol !== 'https:' || webhookUrl.username || webhookUrl.password || webhookUrl.hash) {
    throw new Error('Webhook URL must be a public HTTPS URL without credentials or fragment');
  }
  const apiBaseUrl = new URL(options.apiBaseUrl ?? 'https://api.telegram.org');
  if (!['https:', 'http:'].includes(apiBaseUrl.protocol) || apiBaseUrl.username || apiBaseUrl.password || apiBaseUrl.search || apiBaseUrl.hash) {
    throw new Error('Invalid Telegram API base URL');
  }
}

async function safeFetch(fetchImpl: typeof fetch, input: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Telegram request failed');
  }
}

async function parseTelegramResponse(response: Response): Promise<TelegramResult> {
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
      throw new Error('invalid shape');
    }
    return value as TelegramResult;
  } catch {
    throw new Error('Telegram returned an invalid JSON response');
  }
}

async function main(): Promise<void> {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const webhookSecret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  const webhookUrl = requireEnv('TELEGRAM_WEBHOOK_URL');
  await registerWebhook({ botToken, webhookSecret, webhookUrl });
  console.log(`Webhook registered and verified for ${new URL(webhookUrl).origin}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Webhook registration failed');
    process.exitCode = 1;
  });
}

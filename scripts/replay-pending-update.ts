export {};

async function main(): Promise<void> {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const webhookSecret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  const webhookUrl = requireEnv('TELEGRAM_WEBHOOK_URL');
  const updatesResponse = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?limit=1&timeout=0`, {
    signal: AbortSignal.timeout(15_000)
  });
  if (!updatesResponse.ok) throw new Error(`Telegram getUpdates returned HTTP ${updatesResponse.status}`);
  const updatesBody: unknown = await updatesResponse.json();
  const update = firstUpdate(updatesBody);
  if (update === undefined) {
    console.log('No pending update available for replay');
    return;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': webhookSecret
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(25_000)
  });
  console.log(`Replayed webhook status: ${response.status}`);
  const body = await response.text();
  if (body.length > 0) console.log(`Replayed webhook body: ${sanitize(body)}`);
}

function firstUpdate(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const result = (value as { result?: unknown }).result;
  return Array.isArray(result) ? result[0] : undefined;
}

function sanitize(value: string): string {
  const singleLine = value.replace(/[\r\n]+/gu, ' ').trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Pending update replay failed');
  process.exitCode = 1;
});

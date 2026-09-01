import { ConfigurationError } from './domain/errors';
import { MailboxConfigError, createAllowedZoneMap, type AllowedZoneMap } from './domain/mailbox';

export interface Env {
  BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SEND_ENABLED?: string;
  READ_ENABLED?: string;
  INBOX_ENABLED?: string;
  HELP_ENABLED?: string;
  ALLOWED_ZONE_MAP?: string;
  ZONE_MAP?: string;
  TELEGRAM_API_BASE_URL?: string;
  CLOUDFLARE_API_BASE_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  EXTERNAL_WRITER_URL?: string;
  EXTERNAL_WRITER_SHARED_SECRET?: string;
  DNS_TTL_SECONDS?: string;
  RATE_SENDER_CAPACITY?: string;
  RATE_MAILBOX_CAPACITY?: string;
  RATE_WINDOW_SECONDS?: string;
  PROVIDER_TIMEOUT_SECONDS?: string;
  COORDINATOR?: DurableObjectNamespace<undefined>;
}

export class MissingBindingError extends ConfigurationError {
  constructor(readonly bindingName: string) {
    super(`Missing required binding: ${bindingName}`);
    this.name = 'MissingBindingError';
  }
}

export class InvalidBindingError extends ConfigurationError {
  constructor(readonly bindingName: string) {
    super(`Invalid binding: ${bindingName}`);
    this.name = 'InvalidBindingError';
  }
}

export interface WebhookConfig {
  readonly secret: string;
}

export function webhookConfig(env: Env): WebhookConfig {
  const secret = requireBinding(env.TELEGRAM_WEBHOOK_SECRET, 'TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new InvalidBindingError('TELEGRAM_WEBHOOK_SECRET');
  return { secret };
}

export interface SendFeatureConfig {
  readonly sendEnabled: boolean;
  readonly allowedZones: () => AllowedZoneMap;
}

export interface ExternalWriterConfig {
  readonly endpoint: string;
  readonly sharedSecret: string;
}

export function externalWriterConfig(env: Env): ExternalWriterConfig {
  const endpoint = requireBinding(env.EXTERNAL_WRITER_URL, 'EXTERNAL_WRITER_URL');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new InvalidBindingError('EXTERNAL_WRITER_URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new InvalidBindingError('EXTERNAL_WRITER_URL');
  }
  const sharedSecret = requireBinding(env.EXTERNAL_WRITER_SHARED_SECRET, 'EXTERNAL_WRITER_SHARED_SECRET');
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(sharedSecret)) {
    throw new InvalidBindingError('EXTERNAL_WRITER_SHARED_SECRET');
  }
  return { endpoint: parsed.href.endsWith('/') && !endpoint.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href, sharedSecret };
}

export interface CoordinatorPublishConfig {
  readonly apiToken: string;
  readonly allowedZones: AllowedZoneMap;
  readonly ttl: number;
  readonly timeoutMilliseconds: number;
  readonly budgetMilliseconds: number;
  readonly apiBaseUrl?: string;
}

export function coordinatorPublishConfig(env: Env): CoordinatorPublishConfig {
  const apiToken = requireBinding(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN');
  const ttl = parseInteger(env.DNS_TTL_SECONDS, 'DNS_TTL_SECONDS', 60, 30, 86_400);
  const timeoutSeconds = parseInteger(
    env.PROVIDER_TIMEOUT_SECONDS,
    'PROVIDER_TIMEOUT_SECONDS',
    15,
    1,
    30
  );
  const apiBaseUrl = env.CLOUDFLARE_API_BASE_URL;
  return {
    apiToken,
    allowedZones: parseAllowedZones(env.ALLOWED_ZONE_MAP ?? env.ZONE_MAP),
    ttl,
    timeoutMilliseconds: timeoutSeconds * 1_000,
    budgetMilliseconds: 45_000,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl })
  };
}

export function sendFeatureConfig(env: Env): SendFeatureConfig {
  const sendEnabled = parseBoolean(env.SEND_ENABLED, 'SEND_ENABLED', true);
  return {
    sendEnabled,
    allowedZones: () => parseAllowedZones(env.ALLOWED_ZONE_MAP ?? env.ZONE_MAP)
  };
}

export interface HelpFeatureConfig {
  readonly helpEnabled: boolean;
  readonly allowedZoneSuffixes: () => readonly string[];
  readonly ttlSeconds: number;
}

export function helpFeatureConfig(env: Env): HelpFeatureConfig {
  const helpEnabled = parseBoolean(env.HELP_ENABLED, 'HELP_ENABLED', true);
  return {
    helpEnabled,
    allowedZoneSuffixes: () => parseHelpZoneSuffixes(env.ALLOWED_ZONE_MAP ?? env.ZONE_MAP),
    ttlSeconds: helpEnabled
      ? parseInteger(env.DNS_TTL_SECONDS, 'DNS_TTL_SECONDS', 60, 30, 86_400)
      : 60
  };
}

export interface ReadFeatureConfig {
  readonly readEnabled: boolean;
  readonly timeoutMilliseconds: number;
}

export function readFeatureConfig(env: Env): ReadFeatureConfig {
  if (env.READ_ENABLED !== undefined && env.INBOX_ENABLED !== undefined &&
      env.READ_ENABLED !== env.INBOX_ENABLED) {
    throw new InvalidBindingError('INBOX_ENABLED');
  }
  const readBindingName = env.READ_ENABLED === undefined ? 'INBOX_ENABLED' : 'READ_ENABLED';
  const readBinding = env.READ_ENABLED ?? env.INBOX_ENABLED;
  const readEnabled = parseBoolean(readBinding, readBindingName, true);
  const timeoutSeconds = readEnabled
    ? parseInteger(env.PROVIDER_TIMEOUT_SECONDS, 'PROVIDER_TIMEOUT_SECONDS', 15, 1, 30)
    : 15;
  return {
    readEnabled,
    timeoutMilliseconds: timeoutSeconds * 1_000
  };
}

export interface TelegramBotConfig {
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMilliseconds: number;
}

/**
 * The composition root owns Telegram credentials and endpoint configuration.
 * Callers should receive this validated immutable view rather than reading
 * environment bindings directly.
 */
export function telegramBotConfig(env: Env): TelegramBotConfig {
  const botToken = requireBinding(env.BOT_TOKEN, 'BOT_TOKEN');
  const timeoutSeconds = parseInteger(
    env.PROVIDER_TIMEOUT_SECONDS,
    'PROVIDER_TIMEOUT_SECONDS',
    15,
    1,
    30
  );
  const apiBaseUrl = env.TELEGRAM_API_BASE_URL;
  if (apiBaseUrl !== undefined) {
    try {
      const url = new URL(apiBaseUrl);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
          url.username.length > 0 || url.password.length > 0 ||
          url.search.length > 0 || url.hash.length > 0) {
        throw new InvalidBindingError('TELEGRAM_API_BASE_URL');
      }
    } catch (error) {
      if (error instanceof InvalidBindingError) throw error;
      throw new InvalidBindingError('TELEGRAM_API_BASE_URL');
    }
  }
  return {
    botToken,
    timeoutMilliseconds: timeoutSeconds * 1_000,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl })
  };
}

export const telegramSendConfig = telegramBotConfig;
export const telegramConfig = telegramBotConfig;

function parseAllowedZones(value: string | undefined): AllowedZoneMap {
  if (value === undefined) throw new InvalidBindingError('ALLOWED_ZONE_MAP');
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isZoneEntries(parsed)) throw new InvalidBindingError('ALLOWED_ZONE_MAP');
    return createAllowedZoneMap(parsed);
  } catch (error) {
    if (error instanceof InvalidBindingError) throw error;
    if (error instanceof MailboxConfigError || error instanceof SyntaxError) {
      throw new InvalidBindingError('ALLOWED_ZONE_MAP');
    }
    throw error;
  }
}

function parseHelpZoneSuffixes(value: string | undefined): readonly string[] {
  if (value === undefined) throw new InvalidBindingError('ALLOWED_ZONE_MAP');
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isZoneEntries(parsed)) throw new InvalidBindingError('ALLOWED_ZONE_MAP');
    if (parsed.length === 0) return [];
    return createAllowedZoneMap(parsed).map((zone) => zone.suffix);
  } catch (error) {
    if (error instanceof InvalidBindingError) throw error;
    if (error instanceof MailboxConfigError || error instanceof SyntaxError) {
      throw new InvalidBindingError('ALLOWED_ZONE_MAP');
    }
    throw error;
  }
}

function parseBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InvalidBindingError(name);
}

function parseInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return defaultValue;
  if (!/^[0-9]+$/u.test(value)) throw new InvalidBindingError(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvalidBindingError(name);
  }
  return parsed;
}

function isZoneEntries(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.every((entry) =>
    Array.isArray(entry) && entry.length === 2 &&
    typeof entry[0] === 'string' && typeof entry[1] === 'string'
  );
}

function requireBinding(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new MissingBindingError(name);
  return value;
}

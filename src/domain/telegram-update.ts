export interface TelegramUpdate {
  readonly updateId: number;
  readonly kind: string;
  readonly text?: string;
  /**
   * The chat that owns a message. Telegram chat identifiers may be negative
   * (groups/supergroups), so this is deliberately distinct from senderId.
   */
  readonly chatId?: number;
  readonly senderId?: number;
  readonly senderUsername?: string;
}

const MAX_TELEGRAM_USER_ID = Number.MAX_SAFE_INTEGER;

export type TelegramUpdateParseResult =
  | { readonly status: 'valid'; readonly update: TelegramUpdate }
  | { readonly status: 'unsupported' }
  | { readonly status: 'invalid' };

const SUPPORTED_UPDATE_FIELDS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query'
] as const;

export function parseTelegramUpdate(value: unknown): TelegramUpdateParseResult {
  if (!isRecord(value) || !Number.isSafeInteger(value.update_id) || (value.update_id as number) < 0) {
    return { status: 'invalid' };
  }

  const kind = SUPPORTED_UPDATE_FIELDS.find((field) => isRecord(value[field]));
  if (kind === undefined) return { status: 'unsupported' };

  const source = value[kind] as Record<string, unknown>;
  const sender = source.from;
  if (sender !== undefined && (!isRecord(sender) || !isTelegramUserId(sender.id) ||
      (sender.username !== undefined && typeof sender.username !== 'string'))) {
    return { status: 'invalid' };
  }
  const chat = source.chat;
  if (chat !== undefined && (!isRecord(chat) || !isTelegramChatId(chat.id))) {
    return { status: 'invalid' };
  }

  const update: TelegramUpdate = {
    updateId: value.update_id as number,
    kind,
    ...(typeof source.text === 'string' ? { text: source.text } : {}),
    ...(isRecord(chat) ? { chatId: chat.id as number } : {}),
    ...(isRecord(sender) ? { senderId: sender.id as number } : {}),
    ...(isRecord(sender) && typeof sender.username === 'string'
      ? { senderUsername: sender.username }
      : {})
  };
  return { status: 'valid', update };
}

function isTelegramUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 &&
    value <= MAX_TELEGRAM_USER_ID;
}

function isTelegramChatId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 &&
    Math.abs(value) <= MAX_TELEGRAM_USER_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

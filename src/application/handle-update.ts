import { parseHelpCommand, parseInboxCommand, parseSendCommand } from '../adapters/telegram-command';
import { canonicalizeMailbox, resolveMailbox, type AllowedZoneMap } from '../domain/mailbox';
import type { TelegramUpdate } from '../domain/telegram-update';
import { reconstructInbox, type InboxState } from './reconstruct-inbox';
import { showHelp } from './show-help';
import type { TxtResolverPort } from './txt-resolver';

export interface SendRequest {
  readonly updateId: number;
  readonly mailbox: string;
  readonly zoneId: string;
  readonly text: string;
  readonly senderId: number;
  readonly senderUsername?: string;
}

export interface SendRequestPort {
  accept(request: SendRequest): Promise<void>;
}

export type UpdateHandlingResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'disabled' }
  | { readonly status: 'malformed' }
  | { readonly status: 'invalid_sender' }
  | { readonly status: 'invalid_mailbox' }
  | { readonly status: 'accepted'; readonly request: SendRequest };

export interface TelegramWebhookMethod {
  readonly method: 'sendMessage';
  readonly chat_id: number;
  readonly text: string;
}

export interface UpdateHandler {
  handle(
    update: TelegramUpdate
  ): Promise<UpdateHandlingResult | InboxHandlingResult | HelpHandlingResult | TelegramWebhookMethod | void>;
}

export interface SendHandlerConfig {
  readonly sendEnabled: boolean;
  readonly allowedZones: () => AllowedZoneMap;
}

export interface InboxHandlerConfig {
  readonly readEnabled: boolean;
}

export interface HelpHandlerConfig {
  readonly helpEnabled: boolean;
  readonly allowedZoneSuffixes: () => readonly string[];
  readonly ttlSeconds: number;
}

export type HelpHandlingResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'help_disabled'; readonly chatId?: number }
  | { readonly status: 'help'; readonly text: string; readonly chatId?: number };

export type InboxHandlingResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'read_disabled' }
  | { readonly status: 'malformed_inbox' }
  | { readonly status: 'invalid_inbox_name' }
  | {
    readonly status: 'resolved';
    readonly name: string;
    readonly inbox: InboxState;
    readonly chatId?: number;
  };

export function createHelpUpdateHandler(config: HelpHandlerConfig): UpdateHandler {
  return {
    async handle(update): Promise<HelpHandlingResult> {
      if (update.kind !== 'message' || update.text === undefined ||
          parseHelpCommand(update.text).status === 'not_help') {
        return { status: 'ignored' };
      }
      if (!config.helpEnabled) {
        return {
          status: 'help_disabled',
          ...(update.chatId === undefined ? {} : { chatId: update.chatId })
        };
      }
      return {
        status: 'help',
        text: showHelp({
          allowedZoneSuffixes: config.allowedZoneSuffixes(),
          ttlSeconds: config.ttlSeconds
        }),
        ...(update.chatId === undefined ? {} : { chatId: update.chatId })
      };
    }
  };
}

export function createInboxUpdateHandler(config: InboxHandlerConfig, resolver: TxtResolverPort): UpdateHandler {
  return {
    async handle(update): Promise<InboxHandlingResult> {
      if (update.kind !== 'message' || update.text === undefined || !isInboxCommand(update.text)) {
        return { status: 'ignored' };
      }
      if (!config.readEnabled) return { status: 'read_disabled' };

      const command = parseInboxCommand(update.text);
      if (command.status === 'not_inbox') return { status: 'ignored' };
      if (command.status === 'malformed') return { status: 'malformed_inbox' };
      const name = canonicalizeMailbox(command.mailbox);
      if (name === null) return { status: 'invalid_inbox_name' };
      return {
        status: 'resolved',
        name,
        inbox: await reconstructInbox(name, resolver),
        ...(update.chatId === undefined ? {} : { chatId: update.chatId })
      };
    }
  };
}

export function createSendUpdateHandler(config: SendHandlerConfig, port: SendRequestPort): UpdateHandler {
  return {
    async handle(update): Promise<UpdateHandlingResult> {
      if (update.kind !== 'message' || update.text === undefined) return { status: 'ignored' };
      if (!isSendCommand(update.text)) return { status: 'ignored' };
      if (!config.sendEnabled) return { status: 'disabled' };

      const command = parseSendCommand(update.text);
      if (command.status === 'not_send') return { status: 'ignored' };
      if (command.status === 'malformed') return { status: 'malformed' };
      if (update.senderId === undefined) return { status: 'invalid_sender' };

      const mailbox = resolveMailbox(command.mailbox, config.allowedZones());
      if (mailbox === null) return { status: 'invalid_mailbox' };

      const request: SendRequest = {
        updateId: update.updateId,
        mailbox: mailbox.fqdn,
        zoneId: mailbox.zoneId,
        text: command.text,
        senderId: update.senderId,
        ...(update.senderUsername === undefined ? {} : { senderUsername: update.senderUsername })
      };
      await port.accept(request);
      return { status: 'accepted', request };
    }
  };
}

export const acceptUpdate: UpdateHandler = {
  async handle(update: TelegramUpdate): Promise<void> {
    void update;
  }
};

function isSendCommand(input: string): boolean {
  return /^\s*\/send(?:@[A-Za-z0-9_]+)?(?=\s|$)/.test(input);
}

function isInboxCommand(input: string): boolean {
  return /^\s*\/inbox(?=\s|$)/.test(input);
}

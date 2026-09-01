import {
  createHelpUpdateHandler,
  createInboxUpdateHandler,
  createSendUpdateHandler,
  type SendRequestPort,
  type TelegramWebhookMethod,
  type UpdateHandler
} from './application/handle-update';
import type { TxtResolverPort } from './application/txt-resolver';
import { CloudflareDohTxtResolver } from './adapters/cloudflare-doh-txt-resolver';
import { ExternalWriterClient } from './adapters/external-writer-client';
import {
  renderInboxState,
  splitTelegramText
} from './adapters/telegram-inbox-renderer';
import { handleTelegramWebhook } from './adapters/telegram-webhook';
import {
  renderOperationalResponse,
  type OperationalResponseStatus
} from './adapters/telegram-operational-response';
import {
  InvalidBindingError,
  MissingBindingError,
  externalWriterConfig,
  helpFeatureConfig,
  readFeatureConfig,
  sendFeatureConfig,
  webhookConfig,
  type Env
} from './config';
export { MailboxCoordinator } from './durable-objects/mailbox-coordinator';

export interface WorkerHandler {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response>;
}

export function createWorker(
  handler?: UpdateHandler,
  sendPort?: SendRequestPort,
  txtResolver?: TxtResolverPort
): WorkerHandler {
  return {
    async fetch(request, env): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === '/health' && request.method === 'GET') return new Response('ok', { status: 200 });
      if (pathname !== '/webhook' || request.method !== 'POST') return new Response('Not Found', { status: 404 });

      try {
        const updateHandler = handler ?? lazyUpdateHandler(env, sendPort, txtResolver);
        return await handleTelegramWebhook(request, webhookConfig(env).secret, updateHandler);
      } catch (error) {
        if (error instanceof MissingBindingError || error instanceof InvalidBindingError) {
          console.error('Required binding is invalid', { binding: error.bindingName });
          return Response.json({ error: 'service_misconfigured' }, { status: 503 });
        }
        console.error('Unhandled webhook error', {
          errorType: error instanceof Error ? error.name : typeof error
        });
        return Response.json({ error: 'internal_error' }, { status: 500 });
      }
    }
  };
}

function lazyUpdateHandler(env: Env, sendPort?: SendRequestPort, txtResolver?: TxtResolverPort): UpdateHandler {
  return {
    async handle(update) {
      if (isHelpUpdate(update)) {
        const result = await createHelpUpdateHandler(helpFeatureConfig(env)).handle(update);
        if (isResultStatus(result, 'help') && result.chatId !== undefined) {
          return telegramWebhookReply(result.chatId, result.text);
        } else if (isResultStatus(result, 'help_disabled') && result.chatId !== undefined) {
          return telegramWebhookReply(result.chatId, renderOperationalResponse('help_disabled'));
        }
        return result;
      }

      if (isInboxUpdate(update)) {
        const config = readFeatureConfig(env);
        const resolver = txtResolver ?? new CloudflareDohTxtResolver({
          timeoutMilliseconds: config.timeoutMilliseconds
        });
        const result = await createInboxUpdateHandler(config, resolver).handle(update);
        if (isResultStatus(result, 'resolved') && result.chatId !== undefined) {
          return telegramWebhookReply(result.chatId, renderInboxState(result.inbox));
        } else if (update.chatId !== undefined) {
          const responseStatus = inboxOperationalStatus(result);
          if (responseStatus !== null) {
            return telegramWebhookReply(update.chatId, renderOperationalResponse(responseStatus));
          }
        }
        return result;
      }

      const sendConfig = sendFeatureConfig(env);
      const result = await createSendUpdateHandler(
        sendConfig,
        sendPort ?? lazyConfiguredSendPort(env)
      ).handle(update);
      if (update.chatId !== undefined) {
        if (isResultStatus(result, 'accepted')) {
          return telegramWebhookReply(
            update.chatId,
            env.EXTERNAL_WRITER_URL === undefined
              ? 'درخواست پیام پذیرفته شد؛ انتشار رکورد دامنه ممکن است با تأخیر انجام شود.'
              : 'پیام با موفقیت در رکورد عمومی دامنه ثبت شد.'
          );
        }
        const responseStatus = sendOperationalStatus(result);
        if (responseStatus !== null) {
          return telegramWebhookReply(update.chatId, renderOperationalResponse(responseStatus));
        }
      }
      return result;
    }
  };
}

function telegramWebhookReply(chatId: number, text: string): TelegramWebhookMethod {
  const chunks = splitTelegramText(text);
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text: chunks[0]!
  };
}

function isResultStatus<T extends string>(
  result: unknown,
  status: T
): result is Record<string, unknown> & { readonly status: T } {
  return typeof result === 'object' && result !== null &&
    (result as { readonly status?: unknown }).status === status;
}

function inboxOperationalStatus(result: unknown): OperationalResponseStatus | null {
  if (isResultStatus(result, 'read_disabled')) return 'read_disabled';
  if (isResultStatus(result, 'malformed_inbox')) return 'malformed_inbox';
  if (isResultStatus(result, 'invalid_inbox_name')) return 'invalid_inbox_name';
  return null;
}

function sendOperationalStatus(result: unknown): OperationalResponseStatus | null {
  if (isResultStatus(result, 'disabled')) return 'send_disabled';
  if (isResultStatus(result, 'malformed')) return 'malformed_send';
  if (isResultStatus(result, 'invalid_sender')) return 'invalid_sender';
  if (isResultStatus(result, 'invalid_mailbox')) return 'invalid_mailbox';
  return null;
}

function isHelpUpdate(update: Parameters<UpdateHandler['handle']>[0]): boolean {
  return update.kind === 'message' && update.text !== undefined &&
    /^\s*\/(?:help|start)(?=\s|$)/u.test(update.text);
}

function isInboxUpdate(update: Parameters<UpdateHandler['handle']>[0]): boolean {
  return update.kind === 'message' && update.text !== undefined && /^\s*\/inbox(?=\s|$)/u.test(update.text);
}

function lazyConfiguredSendPort(env: Env): SendRequestPort {
  if (env.EXTERNAL_WRITER_URL !== undefined || env.EXTERNAL_WRITER_SHARED_SECRET !== undefined) {
    const config = externalWriterConfig(env);
    return new ExternalWriterClient(config);
  }
  return lazyCoordinatorSendPort(env);
}

function lazyCoordinatorSendPort(env: Env): SendRequestPort {
  return {
    async accept(request): Promise<void> {
      await coordinatorSendPort(env).accept(request);
    }
  };
}

function coordinatorSendPort(env: Env): SendRequestPort {
  const namespace = env.COORDINATOR;
  if (namespace === undefined) throw new MissingBindingError('COORDINATOR');
  return {
    async accept(request): Promise<void> {
      const stub = namespace.get(namespace.idFromName(request.mailbox));
      const response = await stub.fetch('https://coordinator.internal/coordinate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
      if (response.status === 429) return;
      if (!response.ok) throw new Error('coordinator_request_failed');
    }
  };
}

export default createWorker();

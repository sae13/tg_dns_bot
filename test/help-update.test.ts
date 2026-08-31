import { describe, expect, it, vi } from 'vitest';
import { createHelpUpdateHandler } from '../src/application/handle-update';
import type { TelegramUpdate } from '../src/domain/telegram-update';

function message(text: string, chatId?: number): TelegramUpdate {
  return {
    updateId: 1,
    kind: 'message',
    text,
    ...(chatId === undefined ? {} : { chatId })
  };
}

describe('createHelpUpdateHandler', () => {
  it.each(['/help', '  /help  ', '/start'])('builds onboarding help for %j', async (text) => {
    const allowedZoneSuffixes = vi.fn(() => ['example.com', 'xn--bcher-kva.example']);
    const handler = createHelpUpdateHandler({
      helpEnabled: true,
      allowedZoneSuffixes,
      ttlSeconds: 60
    });

    const result = await handler.handle(message(text, -10042));
    expect(result).toMatchObject({ status: 'help', chatId: -10042 });
    expect(result).toHaveProperty('text', expect.stringContaining('/send box.example.com متن پیام'));
    expect(result).toHaveProperty('text', expect.stringContaining('/inbox box.example.com'));
    expect(result).toHaveProperty('text', expect.stringContaining('example.com'));
    expect(result).toHaveProperty('text', expect.stringContaining('xn--bcher-kva.example'));
    expect(allowedZoneSuffixes).toHaveBeenCalledOnce();
  });

  it('returns disabled before reading domain configuration', async () => {
    const allowedZoneSuffixes = vi.fn(() => { throw new Error('must not load'); });
    const handler = createHelpUpdateHandler({ helpEnabled: false, allowedZoneSuffixes, ttlSeconds: 60 });

    await expect(handler.handle(message('/help', 42))).resolves.toEqual({
      status: 'help_disabled',
      chatId: 42
    });
    expect(allowedZoneSuffixes).not.toHaveBeenCalled();
  });

  it.each([
    [['safe.example', 'line\nbreak.example']],
    [['safe.example', 42]],
    [['safe.example', '']]
  ] as const)('rejects unsafe display-domain values: %j', async (allowedZoneSuffixes) => {
    const handler = createHelpUpdateHandler({
      helpEnabled: true,
      allowedZoneSuffixes: () => allowedZoneSuffixes as unknown as readonly string[],
      ttlSeconds: 60
    });
    await expect(handler.handle(message('/help', 42))).rejects.toThrow(TypeError);
  });

  it.each(['/help extra', '/start extra', '/help@some_bot', '/sender'])('ignores unsupported help-shaped text %j', async (text) => {
    const allowedZoneSuffixes = vi.fn(() => ['example.com']);
    const handler = createHelpUpdateHandler({ helpEnabled: true, allowedZoneSuffixes, ttlSeconds: 60 });

    await expect(handler.handle(message(text))).resolves.toEqual({ status: 'ignored' });
    expect(allowedZoneSuffixes).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { renderOperationalResponse } from '../src/adapters/telegram-operational-response';

describe('Telegram operational responses', () => {
  it.each([
    ['help_disabled', 'راهنما اکنون غیرفعال است'],
    ['send_disabled', 'ارسال پیام اکنون غیرفعال است'],
    ['read_disabled', 'خواندن صندوق اکنون غیرفعال است'],
    ['malformed_send', '/send box.example.com متن پیام'],
    ['invalid_sender', 'فرستنده'],
    ['invalid_mailbox', 'دامنههای مجاز'],
    ['malformed_inbox', '/inbox box.example.com'],
    ['invalid_inbox_name', '/inbox box.example.com']
  ] as const)('renders %s as an actionable Persian plain-text response', (status, expected) => {
    const rendered = renderOperationalResponse(status);
    expect(rendered).toContain(expected);
    expect(rendered).not.toMatch(/<[^>]+>|\*\*|__|`/u);
  });

  it('keeps command examples on independent lines', () => {
    const rendered = renderOperationalResponse('malformed_send');
    expect(rendered.split('\n')).toContain('/send box.example.com متن پیام');
    expect(rendered).not.toMatch(/[\u0600-\u06ff].*\/send/u);
  });

  it.each(['unknown', 'toString', '__proto__'])(
    'fails safely for unknown or inherited response status %j',
    (status) => {
      expect(() => renderOperationalResponse(status as never)).toThrow(TypeError);
    }
  );
});

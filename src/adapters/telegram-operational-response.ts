export type OperationalResponseStatus =
  | 'help_disabled'
  | 'send_disabled'
  | 'read_disabled'
  | 'malformed_send'
  | 'invalid_sender'
  | 'invalid_mailbox'
  | 'malformed_inbox'
  | 'invalid_inbox_name';

const RESPONSES: Readonly<Record<OperationalResponseStatus, string>> = {
  help_disabled: 'راهنما اکنون غیرفعال است. لطفاً بعداً دوباره تلاش کنید.',
  send_disabled: 'ارسال پیام اکنون غیرفعال است. لطفاً بعداً دوباره تلاش کنید.',
  read_disabled: 'خواندن صندوق اکنون غیرفعال است. لطفاً بعداً دوباره تلاش کنید.',
  malformed_send: [
    'نام کامل صندوق و متن پیام را وارد کنید.',
    'نمونهٔ درست:',
    '/send box.example.com متن پیام'
  ].join('\n'),
  invalid_sender: 'مشخصات فرستنده در این پیام در دسترس نیست. فرمان را از یک گفتوگوی معمولی تلگرام دوباره بفرستید.',
  invalid_mailbox: [
    'نام صندوق معتبر نیست یا در یکی از دامنههای مجاز نوشتن قرار ندارد.',
    'اگر راهنما فعال است، دامنههای مجاز را با این فرمان ببینید:',
    '/help'
  ].join('\n'),
  malformed_inbox: [
    'فقط نام دقیق و کامل صندوق را وارد کنید.',
    'نمونهٔ درست:',
    '/inbox box.example.com'
  ].join('\n'),
  invalid_inbox_name: [
    'نام صندوق معتبر نیست. نشانی اینترنتی یا نشانی عددی پذیرفته نمیشود.',
    'نمونهٔ درست:',
    '/inbox box.example.com'
  ].join('\n')
};

export function renderOperationalResponse(status: OperationalResponseStatus): string {
  if (!Object.hasOwn(RESPONSES, status)) throw new TypeError('Unknown operational response status');
  return RESPONSES[status];
}

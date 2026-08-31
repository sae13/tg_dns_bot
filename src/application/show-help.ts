export interface HelpContentInput {
  readonly allowedZoneSuffixes: readonly string[];
  readonly ttlSeconds: number;
}

export function showHelp(input: HelpContentInput): string {
  if (!Array.isArray(input.allowedZoneSuffixes) ||
      !input.allowedZoneSuffixes.every((suffix) =>
        typeof suffix === 'string' && suffix.length > 0 && !/[\r\n]/u.test(suffix)) ||
      !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 86_400) {
    throw new TypeError('Invalid help content input');
  }

  const lines = [
    'این بات برای هر صندوق عمومی فقط آخرین پیام همان صندوق را نگه میدارد و تاریخچه ندارد.',
    '',
    'صندوق همان نام کامل دامنه است؛ آن را دقیق و بدون نشانی اینترنتی وارد کنید.',
    '',
    'برای گذاشتن یا جایگزینکردن آخرین پیام:',
    '',
    '/send box.example.com متن پیام',
    '',
    'برای خواندن یک نام دقیق دامنه:',
    '',
    '/inbox box.example.com',
    '',
    'خواندن نام دقیق هر دامنهٔ عمومی ممکن است و به دامنههای مجاز نوشتن محدود نیست.',
    '',
    'دامنههای مجاز نوشتن:'
  ];
  if (input.allowedZoneSuffixes.length === 0) {
    lines.push('', 'فعلاً هیچ دامنهای برای نوشتن فعال نیست.');
  } else {
    for (const suffix of input.allowedZoneSuffixes) lines.push('', suffix);
  }
  lines.push(
    '',
    'هشدار حریم خصوصی:',
    '',
    'هرکس نام صندوق را بداند میتواند متن پیام، شناسه و نام کاربری فرستنده و زمان ثبت را در رکورد عمومی دامنه ببیند. این سرویس محرمانه نیست و هیچ تضمین محرمانگی ندارد.',
    '',
    'گذرواژه، کد ورود، کلید، اطلاعات بانکی یا هر دادهٔ حساس دیگری نفرستید.',
    '',
    'هشدار حافظهٔ نهان:',
    '',
    'پس از ثبت موفق ممکن است بعضی خوانندهها تا پایان زمان حافظهٔ نهان هنوز مقدار قبلی را ببینند.',
    '',
    'زمان حافظهٔ نهان برحسب ثانیه:',
    '',
    String(input.ttlSeconds)
  );
  return lines.join('\n');
}

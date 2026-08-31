---
title: 'داستان ۱.۲: پذیرش فرمان ارسال و اعتبارسنجی صندوق'
type: 'feature'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** ورکر update را میپذیرد ولی فرمان، قابلیت و محدودهٔ صندوق را نمیسنجد؛ درخواست معتبر و ردشده مرز امن ندارند.

**رویکرد:** فرمان ارسال تجزیه، فاصلههای متن حفظ و FQDN پس از معیارسازی IDN با مرز برچسب به ناحیهٔ مجاز متصل شود. فقط نتیجهٔ معتبر به پورت بعدی برسد.

## مرزها و محدودیتها

**همیشه:** ارسال خاموش پیش از parsing عمیق و خواندن نگاشت `disabled` بدهد؛ نبود صندوق/متن `malformed` و نام خراب/غیرمجاز `invalid_mailbox` باشد؛ بزرگی حروف، نقطهٔ پایانی و IDN معیار شوند؛ خود پسوند و زیردامنهٔ واقعی پذیرفته شوند؛ همهٔ ردها پیش از پورت، سهمیه و fetch رخ دهند.

**هرگز:** Telegram/Cloudflare/DNS، Durable Object، نرخ، codec یا mutation اینجا اجرا نشود؛ URL، IP، برچسب خراب، پسوند رشتهای یا IDN خراب پذیرفته نشود؛ مشخصات ۱.۱ تغییر نکند.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی | رفتار |
|---|---|---|
| معتبر | `/send Box.Example.  hello   world` | نام/ناحیهٔ معیار؛ متن `hello   world` |
| ناقص | `/send`، فقط صندوق، متن سفید | `malformed`، بدون اثر |
| نام ردشده | URL، IP، خراب، `evil-example.com` | `invalid_mailbox`، بدون اثر |
| خاموش | `SEND_ENABLED=false`، نگاشت خراب | `disabled` پیش از parsing |
| IDN | Unicode/punycode همارز | A-label یکسان؛ IDN خراب رد |

</frozen-after-approval>

## نقشهٔ کد

- `src/domain/telegram-update.ts` — حمل متن بدون شکستن ۱.۱.
- `src/domain/mailbox.ts` — معیارسازی FQDN/IDN و ناحیه.
- `src/adapters/telegram-command.ts` — parsing و فاصلهها.
- `src/application/handle-update.ts` — نتیجهها و پورت معتبر.
- `src/config.ts`، `src/index.ts` — تنظیم قابلیتآگاه و composition.
- `test/{send-command,mailbox,send-update,index}.test.ts` — واحد، wiring و نبود اثر.

## کارها و پذیرش

**اجرا:**
- [ ] parser و فاصلهها را با TDD بساز.
- [ ] IDN و مجوز چندناحیهای مرز-برچسبی را با TDD بساز.
- [ ] حالتهای ignored/disabled/malformed/invalid/accepted و پورت را نوعمند کن.
- [ ] متن update و تنظیمات را به Worker وصل و ۱.۱ را حفظ کن.

**معیارهای پذیرش:**
- با فرمان معتبر و چند نگاشت، webhook نام و zone id درست را یکبار تحویل دهد.
- هر رد هیچ fetch، سهمیه، Durable Object یا mutation ایجاد نکند.
- ارسال خاموش بدون الزام نگاشت معتبر `disabled` دهد.
- Unicode و punycode همارز به FQDN و zone id یکسان برسند.

## گزارش تغییر مشخصات

## گزارش پالایش بازبینی

## یادداشتهای طراحی

IDNA بومی Workers همراه بررسی مستقل syntax، طول و IP نبودن استفاده شود. مجوز فقط برابری یا `'.' + suffix` است؛ نگاشت تکراری یا همپوشان نامعتبر است.

## راستیآزمایی

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npx wrangler deploy --dry-run`

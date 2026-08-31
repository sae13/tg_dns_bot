---
title: 'داستان ۱.۱: راهاندازی امن ورکر و وبهوک تلگرام'
type: 'feature'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/planning-artifacts/sprint-change-proposal-2026-08-30.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** محصول باید روی کلودفلر ورکرز مستقر شود، اما مخزن هنوز ورکر، مسیر webhook، قرارداد bindings یا آزمون زمان اجرای Workers ندارد. پذیرش درخواست جعلی یا وابستگی به پردازهٔ دائمی، استقرار را ناامن یا ناممکن میکند.

**رویکرد:** یک پروژهٔ TypeScript بومی Cloudflare Workers ساخته شود که webhook تلگرام را پس از بررسی secret token میپذیرد، تنظیمات و رازها را از bindings نوعمند میگیرد و بدون long polling یا وضعیت درون isolate کار میکند.

## مرزها و محدودیتها

**همیشه:** هستهٔ دامنه از APIهای Workers و سرویسهای بیرونی مستقل باشد؛ webhook پیش از تجزیهٔ payload هدر امنیتی را بررسی کند؛ رازها فقط از secret bindings خوانده و در گزارش پوشانده شوند؛ پاسخ سلامت عمومی و فاقد اطلاعات محرمانه باشد؛ آزمونها در محیط Workers و بدون شبکهٔ واقعی اجرا شوند.

**هرگز:** Python، Pyodide، aiogram، long polling، container، resolver سیستمی یا پایگاه داده افزوده نشود؛ در این داستان منطق فرمان ارسال، codec، Durable Object، تغییر DNS یا ثبت واقعی webhook پیاده نشود؛ توکنها در پروندهٔ Wrangler یا مخزن نوشته نشوند.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی یا وضعیت | خروجی یا رفتار مورد انتظار | مدیریت خطا |
|---|---|---|---|
| سلامت | درخواست به مسیر سلامت | پاسخ موفق کوتاه بدون تنظیمات | بدون اثر جانبی |
| webhook معتبر | درخواست POST با secret token درست و JSON معتبر تلگرام | update به کاربرد ورودی تحویل و سریع پاسخ داده میشود | خطای کاربرد به پاسخ کنترلشده تبدیل میشود |
| secret نامعتبر | هدر غایب یا نابرابر | رد پیش از خواندن و تجزیهٔ بدنه | پاسخ غیرمجاز و گزارش بدون مقدار هدر |
| payload نامعتبر | secret درست و JSON خراب یا update پشتیبانینشده | پاسخ خطای ورودی یا نادیدهگرفتن امن | هیچ فراخوانی بیرونی |
| binding ناقص | راز یا تنظیم الزامی غایب | مسیر وابسته fail-closed است | نام binding گزارش میشود، نه مقدار آن |

</frozen-after-approval>

## نقشهٔ کد

- `package.json` — فرمانهای توسعه، آزمون، بررسی نوع و استقرار.
- `wrangler.toml` — نام Worker، compatibility date و binding غیرمحرمانه؛ بدون راز.
- `tsconfig.json` — TypeScript سختگیرانه و سازگار با Workers.
- `src/index.ts` — fetch handler و مسیریابی سلامت و webhook.
- `src/config.ts` — نوع Env و اعتبارسنجی قابلیتآگاه bindings.
- `src/domain/` — هستهٔ خالص بدون import از Cloudflare یا Telegram.
- `src/application/handle-update.ts` — پورت ورودی حداقلی که فعلاً update معتبر را بدون منطق داستانهای بعد میپذیرد.
- `src/adapters/telegram-webhook.ts` — بررسی هدر، parsing و نگاشت update.
- `test/index.test.ts` — آزمون سلامت، احراز webhook، payload و نبود شبکه.
- `scripts/set-webhook.ts` — خارج از اجرای Worker؛ ثبت تکرارپذیر webhook پس از deploy، بدون چاپ توکن.

## کارها و پذیرش

**اجرا:**
- [x] `package.json`، `tsconfig.json` و `wrangler.toml` — پروژهٔ TypeScript و ابزارهای Workers و Vitest را ایجاد کن.
- [x] `src/config.ts` — قرارداد bindings شامل توکن بات، secret وبهوک، کلیدهای قابلیت، نگاشت ناحیه، endpointهای API و binding آیندهٔ هماهنگکننده را نوعمند کن؛ رازها را در vars قرار نده.
- [x] `src/index.ts` و `src/adapters/telegram-webhook.ts` — مسیر سلامت و webhook را با بررسی ثابتزمان secret پیش از parsing بساز.
- [x] `src/domain/` و `src/application/handle-update.ts` — مرزهای ششضلعی و کاربرد ورودی حداقلی را ایجاد کن؛ API زمان اجرا به دامنه نشت نکند.
- [x] `scripts/set-webhook.ts` — ثبت و بررسی webhook را با fetch و خواندن راز از محیط محلی پیاده کن.
- [x] `test/` — سناریوهای ماتریس، نبود افشای راز و نبود fetch واقعی را پوشش بده.

**معیارهای پذیرش:**
- با فرض پروژهٔ تازه، هنگامی که آزمون و بررسی نوع اجرا میشود، آنگاه Worker در محیط شبیهسازی Workers بدون Python یا Node API ناسازگار بارگذاری میشود.
- با فرض درخواست سلامت، هنگامی که مسیر فراخوانی میشود، آنگاه پاسخ موفق بدون راز و بدون فراخوانی بیرونی برمیگردد.
- با فرض هدر امنیتی غایب یا نادرست، هنگامی که webhook فراخوانی میشود، آنگاه درخواست پیش از parsing رد و هیچ اثر جانبی ایجاد نمیشود.
- با فرض secret درست و update معتبر، هنگامی که webhook فراخوانی میشود، آنگاه update یکبار به کاربرد ورودی تحویل میشود.
- با فرض binding الزامی غایب، هنگامی که مسیر وابسته اجرا میشود، آنگاه fail-closed رخ میدهد و مقدار محرمانه در گزارش یا پاسخ نیست.
- با فرض deploy موفق، هنگامی که فرمان ثبت webhook اجرا میشود، آنگاه URL و secret token به Telegram API ارسال و نتیجه بدون چاپ توکن راستیآزمایی میشود.

## گزارش تغییر مشخصات

این مشخصات جایگزین کامل مشخصات پایتونی قبلی داستان ۱.۱ است.

## گزارش پالایش بازبینی

- اعتبارسنجی ساختاری update تلگرام از حالت پشتیبانینشده جدا شد.
- محدودیت رسانه و اندازهٔ streaming برای بدنهٔ webhook افزوده شد.
- secret تلگرام از نظر طول و نویسههای مجاز اعتبارسنجی شد.
- timeout و گزارش امن برای handler افزوده شد.
- فرمان ثبت webhook دارای اعتبارسنجی ورودی، timeout، خطای شبکهٔ پاکسازیشده و بررسی کامل پاسخ شد.
- مسیر واقعی webhook از entrypoint ورکر و حالتهای خطا با آزمونهای تکمیلی پوشش داده شدند.
- تاریخ سازگاری آزمون و استقرار یکسان و راهنمای استقرار و چرخش راز افزوده شد.

## Review Triage Log

- حذف تکرار update تلگرام به داستان ۱.۷ واگذار شد، زیرا طبق معماری مالک آن Durable Object آینده است و افزودن ذخیرهٔ موقت در این داستان ناامن است.
- اجرای کار کامل در همان درخواست حفظ شد؛ کاربرد فعلی بدون اثر بیرونی است و راهبرد idempotency و صف در داستان ۱.۷ تعریف میشود.
- بررسی pending update و allowed updates در ثبت webhook برای هدف این داستان الزامی نیست؛ تطبیق URL و secret قرارداد پذیرش را ثابت میکند.
- مسیر CI خارج از دامنهٔ داستان راهاندازی Worker است؛ فرمانهای محلی قطعی و مستند شدهاند.
- نام راز Worker و نام محیط اسکریپت عمداً متفاوتاند؛ یکی binding استقرار و دیگری ورودی محلی است و در راهنما صریح مستند شد.

## یادداشتهای طراحی

Durable Object در داستان هماهنگی ساخته میشود؛ در این داستان فقط نوع binding آن پیشبینی میشود تا composition بعدی شکسته نشود. بررسی دسترسی Cloudflare DNS باید در فرمان استقرار یا عملیات مدیریتی انجام شود، نه با هر cold start.

## راستیآزمایی

**فرمانها:**
- `npm test` — انتظار: همهٔ آزمونها بدون شبکهٔ واقعی عبور کنند.
- `npm run typecheck` — انتظار: هیچ خطای TypeScript وجود نداشته باشد.
- `npm run lint` — انتظار: بدون خطای سبک.
- `npx wrangler deploy --dry-run` — انتظار: بستهٔ Worker با bindings اعلامشده ساخته شود و هیچ راز در خروجی bundle نباشد.

## Suggested Review Order

**ورودی و امنیت وبهوک**

- نقطهٔ ورود درخواستمحور و مرزبندی خطاهای پیکربندی را نشان میدهد.
  [`index.ts:9`](../../../src/index.ts#L9)

- احراز ثابتزمان، محدودیت بدنه و تفکیک payload نامعتبر را پیاده میکند.
  [`telegram-webhook.ts:8`](../../../src/adapters/telegram-webhook.ts#L8)

- ساختار update معتبر را از نوع پشتیبانینشده جدا میکند.
  [`telegram-update.ts:17`](../../../src/domain/telegram-update.ts#L17)

**تنظیمات و عملیات استقرار**

- قرارداد رازها و اعتبارسنجی secret وبهوک را متمرکز میکند.
  [`config.ts:31`](../../../src/config.ts#L31)

- ثبت و بازخوانی امن وبهوک با timeout را انجام میدهد.
  [`set-webhook.ts:13`](../../../scripts/set-webhook.ts#L13)

- bindings غیرمحرمانه و تاریخ سازگاری ورکر را تعریف میکند.
  [`wrangler.toml:1`](../../../wrangler.toml#L1)

**راستیآزمایی**

- مسیر واقعی ورکر، احراز، parsing و شکست کاربرد را میآزماید.
  [`index.test.ts:16`](../../../test/index.test.ts#L16)

- قرارداد ثبت، تطبیق و خطاهای Telegram API را میآزماید.
  [`set-webhook.test.ts:12`](../../../test/set-webhook.test.ts#L12)

- توالی استقرار، رازها، چرخش و بازگشت را مستند میکند.
  [`README.md:1`](../../../README.md#L1)

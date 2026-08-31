---
title: 'داستان ۱.۳: ساخت و رفتوبرگشت پیام مدیریتشده'
type: 'feature'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** هنوز مدل نسخهدار و قرارداد انتقالی واحدی برای حمل هویت فرستنده، زمان و متن وجود ندارد؛ در نتیجهٔ پیادهسازی مستقل خواننده و نویسنده ممکن است نویسهها یا معنا را تغییر دهد.

**رویکرد:** یک envelope تغییرناپذیر نسخهٔ یک و codec دامنه ساخته شود که JSON معیار UTF-8 را با ترتیب ثابت کلیدها و Base64URL بدون padding زیر پیشوند `tgdn1:` تولید و فقط دادهٔ معتبر و معیار را بازخوانی کند.

## مرزها و محدودیتها

**همیشه:** فیلدها دقیقاً با ترتیب `v,id,i,n,uid,username,ts,text` سریال شوند؛ `id` یک UUID معیار، `i` و `n` اعداد صحیح یکمبنا و سازگار، `uid` عدد صحیح امن بدون فرض ۳۲بیتی، `username` رشته یا `null`، و `ts` زمان UTC معیار باشد. ساخت از `Date` مستقل از منطقهٔ زمانی با `toISOString()` انجام شود. decoder نتیجهٔ نوعمند بدهد و نسخهٔ ناشناخته، قالب ناشناخته، Base64URL خراب، UTF-8/JSON خراب، envelope نامعتبر و نمایش غیرمعیار را تفکیک کند.

**هرگز:** padding، Base64 معمولی، وابستگی بیرونی، تبدیل زمان برای نمایش، قطع متن، Cloudflare/DNS/TXT splitting، ساخت برنامهٔ انتشار یا تغییر رفتار داستانهای ۱.۱ و ۱.۲ وارد این داستان نشود. payload خراب با coercion، پیشفرض یا حذف فیلد به پیام معتبر تبدیل نشود.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی | رفتار |
|---|---|---|
| معیار | envelope معتبر نسخهٔ یک | خروجی با `tgdn1:`، JSON با ترتیب مصوب و Base64URL بدون `=`؛ ورودی یکسان خروجی یکسان |
| هویت اختیاری | `username` ناموجود یا `null` و `uid` بزرگتر از ۳۲ بیت | نام کاربری `null` و شناسه بدون افت دقت حفظ شود |
| زمان | `Date` دارای offset غیر UTC | رشتهٔ ISO UTC ذخیره شود و codec آن را تغییر ندهد |
| نویسه | فارسی، شکلک، نقلقول، ممیز معکوس و ترکیب آنها | تمام فیلدها بایتبهبایت معنایی رفتوبرگشت کنند |
| نسخه | پیشوند یا `v` ناشناخته | خطای نوعمند `unsupported_version` |
| خرابی | Base64URL، UTF-8، JSON، shape یا ترتیب غیرمعیار | خطای نوعمند متناسب؛ بدون throw و بدون پیام جزئی |

</frozen-after-approval>

## نقشهٔ کد

- `src/domain/managed-message.ts` — نوع envelope نسخهٔ یک، factory معیار و اعتبارسنجی ناورداهای پیام/قطعه/هویت/زمان.
- `src/domain/managed-message-codec.ts` — مالک یگانهٔ پیشوند، JSON معیار، UTF-8، Base64URL بدون padding و taxonomy بازخوانی؛ بدون کتابخانهٔ بیرونی.
- `test/managed-message.test.ts` — ساخت پیام، UTC، نام کاربری nullable، UUID/قطعه/شناسه و validation.
- `test/managed-message-codec.test.ts` — بردار طلایی مستقل، قطعیبودن، نویسههای چندزبانه و همهٔ طبقههای خطای decoder.
- `src/application/handle-update.ts` و adapterهای موجود — فقط شاهد مرز؛ در این داستان تغییر نمیکنند چون هنوز ذخیره/برنامهٔ انتشار در داستانهای بعدی است.

## کارها و پذیرش

**اجرا:**
- [x] `test/managed-message.test.ts` سپس `src/domain/managed-message.ts` — ناورداها و ساخت UTC را با چرخهٔ قرمز/سبز پیاده کن.
- [x] `test/managed-message-codec.test.ts` سپس `src/domain/managed-message-codec.ts` — قرارداد قطعی و بردارهای طلایی را با چرخهٔ قرمز/سبز پیاده کن.
- [x] `test/managed-message-codec.test.ts` — payloadهای ناشناخته، خراب و غیرمعیار را بدون پذیرش اجباری پوشش بده.

**معیارهای پذیرش:**
- با envelope منطقی یکسان، هر بار wire payload دقیقاً یکسان، بدون padding و با ترتیب مصوب باشد.
- با متن فارسی/شکلک/نقلقول/ممیز معکوس و username حاضر یا غایب، encode و decode همان envelope را برگردانند.
- با منطقهٔ زمانی ورودی متفاوت، `ts` همواره UTC معیار باشد و تبدیل به `Asia/Tehran` در دامنه/codec رخ ندهد.
- با نسخه، encoding، UTF-8، JSON، shape یا canonical form نامعتبر، decoder نتیجهٔ خطای طبقهبندیشده بدهد و دادهٔ جزئی بازنگرداند.
- مجموعهٔ کامل قبلی و چهار دروازهٔ پروژه بدون regression عبور کنند.

## گزارش تغییر مشخصات

## گزارش اصلاحات بازبینی

- اصلاح شد: encoder اکنون envelope را در مرز runtime اعتبارسنجی میکند و دادهٔ castشدهٔ نامعتبر نمیسازد.
- اصلاح شد: decoder ورودی runtime غیررشتهای را به `invalid_format` طبقهبندی میکند.
- اصلاح شد: ساخت زمان از formatter ذاتی `Date` استفاده میکند تا override نمونه نتواند UTC معیار را بشکند.
- تکمیل شد: آزمونهای index اعشاری و immutable بودن envelope بازخوانیشده افزوده شدند.

## گزارش پالایش بازبینی

- رد شد: ادعای placeholder بودن `GOLDEN_WIRE` حاصل کوتاهسازی نمایشی خروجی ابزار بود؛ فایل واقعی بردار کامل دارد و آزمون اجراشده میگذرد.
- رد شد: درخواست محدودیت اندازه و TXT splitting خارج از Story 1.3 است و Story 1.4 مالک ظرفیت نهایی و برش است.
- رد شد: integration با application/adapter در Story 1.3 لازم نیست؛ ذخیره و برنامهٔ انتشار صریحاً به داستانهای بعد واگذار شدهاند.
- رد شد: وضعیت `in-review` مشخصات درحالی که sprint هنوز `in-progress` است حالت میانی workflow است و در پایان review همگام میشود.
- رد شد: `NO_VCS` واقعی است؛ مسیر پروژه repository نسخهکنترلشده نیست و baseline قابل ساختن وجود ندارد.
- رد شد: UUID all-zero با regex فعلی پذیرفته نمیشود چون version و variant معتبر ندارد؛ محدودیت معنایی دیگری در معماری الزام نشده است.
- رد شد: نبود آزمون مستقیم helperهای خصوصی/اعتبارسنجیهای تکراری شکاف رفتاری مستقل نیست؛ رفتار از factory و decoder پوشش داده میشود.

## یادداشتهای طراحی

decoder پس از parse و اعتبارسنجی، envelope را دوباره encode و با ورودی مقایسه میکند؛ این کار padding، ترتیب دیگر کلیدها و escapeهای غیرمعیار را رد و تنها یک نمایش wire را معتبر میکند. نمایش زمان ایران عمداً مرز presentation داستان خواندن است و در این codec فقط UTC حفظ میشود.

## راستیآزمایی

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npx wrangler deploy --dry-run`

## ترتیب پیشنهادی بازبینی

**قرارداد دامنه**

- factory تغییرناپذیر، UTC معیار و ناورداهای envelope را یکجا اعمال میکند.
  [`managed-message.ts:38`](../../src/domain/managed-message.ts#L38)

- parser مرز اعتماد decoder را با shape و مقدار دقیق میبندد.
  [`managed-message.ts:60`](../../src/domain/managed-message.ts#L60)

**قرارداد انتقال**

- encoder ترتیب معیار و Base64URL بدون padding را مالک است.
  [`managed-message-codec.ts:28`](../../src/domain/managed-message-codec.ts#L28)

- decoder خرابیها را طبقهبندی و نمایش غیرمعیار را رد میکند.
  [`managed-message-codec.ts:43`](../../src/domain/managed-message-codec.ts#L43)

**شواهد آزمون**

- بردار طلایی قطعی و قواعد wire مستقل از round-trip تثبیت شدهاند.
  [`managed-message-codec.test.ts:24`](../../test/managed-message-codec.test.ts#L24)

- ورودیهای چندزبانه و تمام طبقههای خطا رفتوبرگشت و رد میشوند.
  [`managed-message-codec.test.ts:48`](../../test/managed-message-codec.test.ts#L48)

- factory، UTC، UUID و ورودیهای runtime نامعتبر پوشش دارند.
  [`managed-message.test.ts:11`](../../test/managed-message.test.ts#L11)

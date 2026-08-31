---
title: 'داستان ۲.۲: بازسازی پیام مدیریتشده و حالتهای نوعمند صندوق'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** نتیجهٔ خام DoH هنوز پیام مدیریتشده را بازسازی نمیکند و نمیتواند نبود داده، دادهٔ خام/خراب، root مبهم یا مجموعهٔ ناقص قطعهها را بهصورت type-safe از پیام کامل جدا کند؛ در نتیجه دادهٔ ناسازگار ممکن است با پیام معتبر اشتباه شود.

**Approach:** یک use case مستقل از DNS و تلگرام بساز که root را از تمام RRهای خام تحلیل کند، برنامهٔ exact-name قطعهها را فقط از manifest معتبر بسازد، پاسخهای قطعهها را با codec موجود بررسی و یک حالت بسته و نوعمند همراه با تمام شواهد خام برگرداند.

## Boundaries & Constraints

**Always:** ترتیب RR بیاثر و ترتیب قطعه فقط از `i` است؛ یک root معتبر لازم است؛ هویت دقیق پیام شامل `v,id,uid,username,ts,n` در همهٔ قطعهها ثابت و `i` یکتا باشد؛ قطعهٔ `1` همان manifest در نام اصلی و قطعههای `2..n` فقط در `<i>.<root>` پرسیده شوند؛ TXT نامرتبط فیلتر اما در شواهد خام حفظ شود؛ decode/version error و قطعهٔ مفقود، تکراری یا متعارض هرگز complete نشوند؛ خروجیهای absent/raw-only/complete/ambiguous/incomplete و جزئیات malformed با discriminated union پوشش داده شوند.

**Never:** کشف زیردامنه، حدس نام قطعه بدون manifest، ترکیب شناسهها یا metadata متفاوت، اتکا به ترتیب RR، اتصال واقعی DNS/Telegram/Cloudflare، نمایش نهایی Story 2.3، deploy، commit یا ویرایش spec منجمد قبلی انجام نشود.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| تک رکورد | یک root معتبر با `i=1,n=1` و RR خام کناری | complete با متن و metadata دقیق؛ raw root حفظ شود | TXT نامرتبط نامزد پیام نیست |
| چند رکورد | manifest معتبر `n>1` و پاسخهای سازگار نامهای ۲ تا n | پرسوجوی قطعی و complete با اتصال متن بهترتیب i | ترتیب RR و زمان پاسخ اثری ندارد |
| root مبهم/خام | صفر یا چند root معتبر | raw-only یا ambiguous؛ هیچ root دلخواه انتخاب نشود | decode/version errors نوعمند و raw حفظ شوند |
| قطعهٔ خراب | مفقود، تکراری، conflicting یا metadata ناسازگار | incomplete با manifest، قطعههای معتبر موجود، مشکلهای نوعمند و همهٔ rawها | هرگز متن کامل ادعا نشود |
| شکست lookup قطعه | NXDOMAIN/NODATA یا خطای DNS/network/timeout/response | incomplete با مشکل همان نام و وضعیت resolver | استثنا یا جزئیات provider نشت نکند |

</frozen-after-approval>

## Code Map

- `src/domain/managed-message-codec.ts` — codec تثبیتشدهٔ `tgdn1:` و taxonomy خطاهای decode؛ بدون تغییر قرارداد مصرف شود.
- `src/domain/managed-message.ts` — envelope و identity metadata معتبر؛ برای بازسازی شیء complete reuse شود.
- `src/domain/publish-plan.ts` — قرارداد نامهای root و `<i>.<root>` و chunk metadata؛ منطق خواندن باید با آن سازگار بماند.
- `src/application/txt-resolver.ts` — `TxtRecord` و outcomeهای عمومی exact-name از Story 2.1.
- `src/application/handle-update.ts` — مسیر `/inbox` اکنون resolution خام برمیگرداند؛ composition باید use case بازسازی را فراخوانی کند.
- `test/inbox-reconstruction.test.ts` — contract دامنه/کاربرد برای تک/چند رکورد، هویت، raw filtering و تمام حالتهای خرابی.
- `test/inbox-update.test.ts`, `test/worker-inbox.test.ts` — adoption مسیر واقعی و حفظ رفتار validation/disable/credential-free.

## Tasks & Acceptance

**Execution:**
- [x] `test/inbox-reconstruction.test.ts` سپس `src/application/reconstruct-inbox.ts` — tracerهای RED/GREEN تکپیام، چندقطعه و union نوعمند را بساز؛ سپس missing/duplicate/conflict/decode/version/raw را اضافه کن.
- [x] `test/inbox-update.test.ts` سپس `src/application/handle-update.ts` — handler را از resolution خام به نتیجهٔ بازسازی compose کن و short-circuitهای قبلی را حفظ کن.
- [x] `test/worker-inbox.test.ts` — مسیر Worker را با fetchهای mock root و قطعهها ثابت کن، بدون credential یا API واقعی.

**Acceptance Criteria:**
- با یک root معتبر تک یا چندقطعهای، وقتی `/inbox` تحلیل میشود، نتیجهٔ complete متن پیوسته و `id/uid/username/ts/n` دقیق envelope را دارد و همهٔ raw RRها حفظ میشوند.
- با چند root معتبر، یا قطعهٔ مفقود/تکراری/متعارض/خراب، وقتی تحلیل میشود، نتیجه فقط ambiguous یا incomplete با شواهد و مشکل نوعمند است و هیچ پیام کامل انتخاب یا ترکیب نمیشود.
- با نبود پاسخ، فقط TXT نامرتبط یا wire خراب/نسخهٔ ناشناخته، وقتی تحلیل میشود، حالت نوعمند absent/raw-only و جزئیات malformed/decode حفظ میشوند و lookup قطعهٔ حدسی رخ نمیدهد.
- مجموعهٔ قبلی و چهار gate پروژه بدون regression عبور میکنند.

## Spec Change Log

## Review Triage Log

- لایهٔ Blind Hunter طبق هدایت کاربر پس از شکست اولیهٔ نبود Git/trusted-directory حذف و با بازبینی داخلی Hermes جایگزین شد؛ یافتههای معتبر لایههای edge-case و verification-gap اعمال شدند.
- یافتهٔ mixed RRset معتبر بود: root یا قطعهٔ سازگار کنار managed خراب/ناسازگار میتوانست complete شود؛ با problemهای نوعمند و آزمونهای root/numbered رفع شد.
- یافتهٔ نبود کران manifest معتبر بود: `n` بزرگ میتوانست lookup نامحدود بسازد؛ سقف ۱۰۰ پیش از هر lookup شمارهدار و آزمون مستقیم افزوده شد.
- یافتهٔ rejection resolver معتبر بود: rejection در root/numbered نشت میکرد؛ اکنون به `resolver_error` نوعمند absent/incomplete تبدیل و آزموده میشود.
- یافتهٔ طبقهبندی مبهم آزمون فرمان معتبر بود؛ جدول exact status جایگزین پذیرش هرکدام از دو status شد.
- یافتههای نبود cap تجمعی RR، `acceptUpdate` و پوشش نمایش Worker رد/خارج محدوده شدند: parser DoH از Story 2.1 کران wire هر RR دارد؛ `acceptUpdate` موجود و خارج diff Story است؛ نمایش state مربوط Story 2.3 است. نامهای مشتقشدهٔ نامعتبر نیز در همین Story fail-closed و آزموده شدند.

## Design Notes

`raw` پاسخ root و همهٔ پاسخهای numbered را با نام/TTL/value نگه میدارد. `malformed` یک evidence نوعمند داخل raw-only/incomplete است، نه پیام قابل بازسازی؛ بدینترتیب پنج حالت معماری ثابت میماند و خطاهای codec نیز exhaustively قابل بررسیاند.

## Verification

**Commands:**
- `npm test` — همهٔ آزمونهای unit/integration با fetch mock عبور کنند.
- `npm run typecheck` — unionها exhaustively type-safe باشند.
- `npm run lint` — بدون خطای lint.
- `npx wrangler deploy --dry-run` — bundle Worker بدون deploy ساخته شود.

## Suggested Review Order

**قرارداد بازسازی**

- union بستهٔ صندوق و شواهد خام، مرز اصلی رفتار خواندن را تعریف میکند.
  [`reconstruct-inbox.ts:40`](../../src/application/reconstruct-inbox.ts#L40)

- انتخاب manifest، کران شمار و ساخت نامهای قطعه fail-closed است.
  [`reconstruct-inbox.ts:76`](../../src/application/reconstruct-inbox.ts#L76)

- سازگاری هویت و خرابی RRهای mixed پیش از complete کنترل میشود.
  [`reconstruct-inbox.ts:111`](../../src/application/reconstruct-inbox.ts#L111)

**اتصال کاربرد**

- `/inbox` نام معیارشده را به use case بازسازی میسپارد.
  [`handle-update.ts:47`](../../src/application/handle-update.ts#L47)

**شواهد آزمون**

- contract جامع تک/چندقطعه و همهٔ حالتهای خرابی را تثبیت میکند.
  [`inbox-reconstruction.test.ts:35`](../../test/inbox-reconstruction.test.ts#L35)

- مسیر Worker فقط نامهای مشتقشده از manifest را با DoH mock میپرسد.
  [`worker-inbox.test.ts:82`](../../test/worker-inbox.test.ts#L82)

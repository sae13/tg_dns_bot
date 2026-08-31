---
title: 'داستان ۲.۱: خواندن عمومی TXT نام دقیق با DNS-over-HTTPS'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** مسیر فقطخواندنی عمومی هنوز وجود ندارد؛ Worker فقط ارسال را compose میکند و هیچ قرارداد نوعمند برای TXT، نبود نام/داده، وضعیت DNS یا پاسخ خراب ندارد.

**Approach:** یک port خالص برای حل TXT و adapter مبتنی بر Cloudflare JSON DoH بساز؛ `/inbox` نام را مستقل از allowlist نوشتن معیار کند و فقط همان پرسوجوی TXT را اجرا کند، با نتایج نوعمند و بدون credential.

## Boundaries & Constraints

**Always:** endpoint پیشفرض `https://cloudflare-dns.com/dns-query`، `GET` با `name` دقیق معیارشده و `type=TXT` و `Accept: application/dns-json` باشد؛ هیچ هدر Authorization یا token/zone map وارد مسیر خواندن نشود؛ timeout کراندار و قابل تزریق باشد؛ `Status=3` برابر NXDOMAIN، `Status=0` بدون TXT برابر NODATA، وضعیتهای DNS دیگر برابر خطای نوعمند باشند؛ CNAME معتبر در همان پاسخ پذیرفته و فقط TXTهای owner قابل دسترس از زنجیرهٔ آن حفظ شوند؛ TTL هر RR و اتصال مرتب segmentهای یک TXT مستقل حفظ شود.

**Never:** از Cloudflare REST API احرازنامهدار، resolver سیستمی، کشف زیردامنه، lookup تکمیلی CNAME، اتصال واقعی در آزمون، deploy، commit، ویرایش specهای منجمد قبلی یا پیادهسازی بازسازی/نمایش Stories 2.2–2.3 استفاده نشود.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TXT مستقیم/چندsegment | پاسخ NOERROR با چند RR | هر RR مستقل با owner، TTL و مقدار segmentهای متصل | RR نامرتبط یا شکل خراب کل پاسخ را نامعتبر میکند |
| CNAME | alias دقیق، زنجیرهٔ CNAME و TXT نهایی | TXT مقصد زنجیره برگردد؛ lookup دوم نشود | loop، fork، target غایب/نامرتبط نامعتبر یا NODATA طبق پاسخ |
| نبود/شکست DNS | NXDOMAIN، NOERROR بدون TXT، SERVFAIL | نتایج `nxdomain`، `nodata` و `dns_error` متمایز | status و پاسخ malformed به نوع امن تبدیل شوند |
| شبکه/timeout | fetch reject یا پایان deadline | `network_error` یا `timeout` | استثنای fetch نشت نکند |
| فرمان | `/inbox` معتبر/نامعتبر/غیرفعال | exact canonical name resolve یا نتیجهٔ disabled/invalid | پیش از fetch رد شود و allowlist/token خوانده نشود |

</frozen-after-approval>

## Code Map

- `src/domain/mailbox.ts` — `canonicalizeMailbox` اعتبارسنج و IDNA مشترک نام است؛ `resolveMailbox` مختص allowlist نوشتن و برای خواندن استفاده نشود.
- `src/application/txt-resolver.ts` — قرارداد تازهٔ resolver و outcomeهای type-safe، مستقل از fetch/Cloudflare.
- `src/adapters/cloudflare-doh-txt-resolver.ts` — تنها مالک fetch عمومی DoH، timeout، schema/status/CNAME/TXT presentation parsing.
- `src/adapters/telegram-command.ts` — parser کوچک `/inbox` بدون متن اضافی.
- `src/application/handle-update.ts` — routing خواندن پیش از send-only path، short-circuit غیرفعال/نامعتبر و فراخوانی port.
- `src/config.ts` و `src/index.ts` — config مستقل خواندن و composition با fetch عمومی؛ `CLOUDFLARE_API_TOKEN` فقط مسیر انتشار میماند.
- `test/cloudflare-doh-txt-resolver.test.ts` — contract mock برای request، status، NXDOMAIN/NODATA، CNAME، TTL، segment، malformed و timeout.
- `test/inbox-update.test.ts`, `test/worker-inbox.test.ts`, `test/config.test.ts` — فرمان exact-name، IDNA، نام خارج allowlist، disabled no-effect و نبود secret.

## Tasks & Acceptance

**Execution:**
- [x] `test/cloudflare-doh-txt-resolver.test.ts` سپس `src/application/txt-resolver.ts` و `src/adapters/cloudflare-doh-txt-resolver.ts` — قرارداد RED/GREEN همهٔ پاسخهای DoH و parser TXT را بساز.
- [x] `test/inbox-update.test.ts` سپس `src/adapters/telegram-command.ts` و `src/application/handle-update.ts` — فرمان و use case exact-name مستقل از write allowlist را RED/GREEN کن.
- [x] `test/worker-inbox.test.ts`, `test/config.test.ts` سپس `src/config.ts`, `src/index.ts` — composition credential-free، disable short-circuit و timeout config را ثابت کن.

**Acceptance Criteria:**
- با read فعال و نام معتبر داخل یا خارج allowlist، وقتی `/inbox` اجرا میشود، فقط یک GET عمومی Cloudflare DoH برای TXT نام معیارشده انجام و تمام RRهای قابل دسترس همنام برگردانده میشوند.
- با token کلودفلر غایب و send غیرفعال، وقتی خواندن فعال است، composition و پرسوجوی mock موفق میشوند و هیچ credential در URL/header/body/log وجود ندارد.
- با نام نامعتبر یا read غیرفعال، وقتی فرمان دریافت میشود، هیچ fetch، zone parsing یا اثر بیرونی رخ نمیدهد.
- مجموعهٔ قبلی و چهار gate پروژه بدون regression عبور میکنند.

## Spec Change Log

## Review Triage Log

- بازبینی داخلی: timeout فقط تا دریافت headers فعال بود؛ یافتن حفظشده و با نگهداشتن AbortController تا پایان JSON body اصلاح شد.
- بازبینی داخلی: parser کران ۲۵۵ بایت هر character-string، سقف ۶۵۵۳۵ بایت RDATA و کران uint32 برای TTL را بررسی نمیکرد؛ با آزمونهای منفی و guard صریح اصلاح شد.
- بازبینی داخلی: وجود همزمان `READ_ENABLED` و `INBOX_ENABLED` متعارض بهصورت ساکت اولویت میگرفت؛ اکنون fail-closed رد میشود.
- یافتهٔ «TXT یا CNAME نامرتبط در Answer باید نادیده گرفته شود» رد شد: قرارداد منجمد پاسخ malformed را invalid میخواهد و آزمون صریح دارد.
- یافتهٔ «CNAME بدون TXT باید lookup دوم بسازد» رد شد: قرارداد منجمد lookup تکمیلی CNAME را ممنوع کرده و NODATA میخواهد.
- یافتهٔ «خروجی Telegram متن نتیجه را نمایش نمیدهد» رد شد: نمایش محتوا و پاسخهای کاربر عمداً در Stories 2.2–2.3 خارج از محدوده است؛ Story 2.1 فقط port، outcome و composition پرسوجو را تحویل میدهد.
- یافتهٔ «DoH باید token وبهوک Telegram را هم نداشته باشد» رد شد: credential-free دربارهٔ اعتبارنامهٔ Cloudflare/DNS است؛ webhook ورودی طبق Story 1.1 همچنان باید secret Telegram داشته باشد و این secret هرگز وارد fetch DoH نمیشود.
- شکاف راستیآزمایی پیدا نشد: test adapter قرارداد request/status/parser/timeout را مستقیم میسنجد، test use-case validation و disable را میسنجد و test Worker adoption واقعی و نبود token/zone-map را میسنجد؛ همه در `npm test` ثبتاند.

## Design Notes

رشتهٔ TXT در JSON DoH presentation-format است، نه payload آماده. parser فقط sequenceهای quoted را میپذیرد، escapeهای `\DDD` را به octet و escape نویسه را به همان نویسه تبدیل میکند و سپس byteها را با UTF-8 سختگیرانه decode میکند. CNAME فقط داخل همان پاسخ و با owner/target معیارشده دنبال میشود؛ هیچ درخواست ضمنی تازه ساخته نمیشود.

## Verification

**Commands:**
- `npm test` — همهٔ آزمونها با fetch mock عبور کنند.
- `npm run typecheck` — قراردادهای discriminated union کامل باشند.
- `npm run lint` — بدون خطای lint.
- `npx wrangler deploy --dry-run` — bundle Workers بدون deploy ساخته شود.

## Suggested Review Order

**مسیر درخواست عمومی**

- composition فرمان خواندن را از مسیر مجوزدار ارسال جدا نگه میدارد.
  [`index.ts:50`](../../src/index.ts#L50)

- use case نام دقیق را معیار و بدون allowlist به resolver میسپارد.
  [`handle-update.ts:47`](../../src/application/handle-update.ts#L47)

**قرارداد DoH و parsing**

- GET عمومی exact-name با deadline کامل و outcomeهای type-safe اجرا میشود.
  [`cloudflare-doh-txt-resolver.ts:36`](../../src/adapters/cloudflare-doh-txt-resolver.ts#L36)

- زنجیرهٔ CNAME فقط از همان پاسخ و بدون lookup ضمنی دنبال میشود.
  [`cloudflare-doh-txt-resolver.ts:105`](../../src/adapters/cloudflare-doh-txt-resolver.ts#L105)

- segmentهای TXT با کران wire و UTF-8 سختگیرانه بازسازی میشوند.
  [`cloudflare-doh-txt-resolver.ts:147`](../../src/adapters/cloudflare-doh-txt-resolver.ts#L147)

**تنظیمات و شواهد**

- read flag و timeout بدون token یا zone map نوعمند میشوند.
  [`config.ts:96`](../../src/config.ts#L96)

- contract test request، status، CNAME، TTL، segment، malformed و timeout را میپوشاند.
  [`cloudflare-doh-txt-resolver.test.ts:12`](../../test/cloudflare-doh-txt-resolver.test.ts#L12)

- آزمون Worker نبود credential و استقلال از تنظیمات نوشتن را ثابت میکند.
  [`worker-inbox.test.ts:36`](../../test/worker-inbox.test.ts#L36)

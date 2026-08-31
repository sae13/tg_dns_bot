---
title: 'داستان ۱.۵: ذخیرهٔ پیام کوتاه روی کلودفلر'
type: 'feature'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 2
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** برای برنامهٔ تکرکوردی داستان ۱.۴ هنوز درگاه ذخیره و سازگارکنندهای وجود ندارد که مجموعهٔ TXT نام را بدون نشت جزئیات ارائهدهنده با آخرین پیام جایگزین کند.

**رویکرد:** یک قرارداد نوعمند برای جایگزینی دقیقاً یک TXT و سازگارکنندهٔ `fetch` کلودفلر بساز که مقصد را دوباره در مرز اثر جانبی مجاز کند، رکورد موجود یکتا را overwrite کند، نبود رکورد را create کند و مجموعهٔ قدیمی چندتایی را با batch به یک رکورد کاهش دهد.

## مرزها و محدودیتها

**همیشه:** نام باید ASCII معیار و متعلق به همان `zoneId` در نگاشت مجاز باشد؛ همهٔ مسیرها و queryها امن ساخته شوند؛ هدر `Authorization: Bearer` و JSON دقیق در هر فراخوانی حاضر باشد؛ payload رکورد از رشتههای ۲۵۵بایتی برنامهٔ انتشار به قالب TXT کلودفلر تبدیل و TTL اعتبارسنجی شود؛ نتیجه و خطا مستقل از کلودفلر و بدون token، payload یا متن پاسخ ارائهدهنده باشد.

**هرگز:** اتصال واقعی، retry/reconciliation داستان ۱.۸، انتشار چندنامی/commit/cleanup داستان ۱.۶، تغییر codec یا برنامهٔ داستان ۱.۴، اتصال به composition root، پاسخ تلگرام، deployment، commit یا ویرایش مشخصات منجمد قبلی وارد این داستان نشود.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی / حالت | رفتار مورد انتظار | مدیریت خطا |
|---|---|---|---|
| ساخت | list دقیق TXT خالی | `POST /zones/{zone}/dns_records` و نتیجهٔ `created` با شناسه | پاسخ نامعتبر/ناموفق به خطای نوعمند تبدیل شود |
| بهروزرسانی | یک TXT دقیق موجود | `PUT /zones/{zone}/dns_records/{id}` و نتیجهٔ `updated` با همان شناسه | شناسه در URL encode شود |
| جایگزینی مجموعهٔ قدیمی | چند TXT دقیق، قدیمی یا ناشناس | batch شامل حذف همه و post دقیقاً یک رکورد؛ نتیجهٔ `updated` | پاسخ مبهم یا ناقص به خطای نوعمند تبدیل شود |
| مقصد ناامن | نام نامعیار، lookalike suffix یا `zoneId` ناسازگار | هیچ fetch انجام نشود | `unsafe_target` بدون بازتاب ورودی |
| نتیجهٔ نامعلوم | fetch پس از آغاز mutation پرتاب شود یا پاسخ mutation قابل اثبات نباشد | موفقیت اعلام نشود | `unknown_result` نوعمند و بدون راز |

</frozen-after-approval>

## نقشهٔ کد

- `src/application/record-store.ts` — قرارداد مستقل از ارائهدهنده برای درخواست تکرکورد، نتیجهٔ created/updated و خطاهای نوعمند.
- `src/adapters/cloudflare-record-store.ts` — مالک REST API، Bearer auth، list/create/update/batch، parsing دفاعی و کنترل دوبارهٔ zone/name.
- `src/domain/mailbox.ts` — `canonicalizeMailbox` و نگاشت suffix→zone موجود؛ فقط reuse و بدون تغییر.
- `src/domain/publish-plan.ts` — `PublishRecord.characterStrings` موجود و سقفهای اثباتشده؛ فقط reuse و بدون تغییر.
- `test/cloudflare-record-store.test.ts` — قرارداد HTTP دقیق با fetch جعلی برای create/update/batch، ایمنی مقصد، طبقهبندی پاسخ و عدم افشای راز.
- `src/config.ts` و `src/index.ts` — خارج از محدوده؛ composition و الزام bindingها در داستان اتصال کاربرد انجام میشود.

## کارها و پذیرش

**اجرا:**
- [x] `test/cloudflare-record-store.test.ts` سپس `src/application/record-store.ts` — قرارداد نتیجه/خطا و شکل درخواست تکرکورد را با آزمون قرمز تثبیت کن.
- [x] `test/cloudflare-record-store.test.ts` سپس `src/adapters/cloudflare-record-store.ts` — create، overwrite و batch جایگزینی مجموعه را با fetch تزریقی و payload دقیق کلودفلر پیاده کن.
- [x] `test/cloudflare-record-store.test.ts` — پاسخهای malformed/non-2xx/network، pagination غیرمنتظره، mismatch ناحیه، lookalike، encoding شناسه و عدم بازتاب token/body را پوشش بده.

**معیارهای پذیرش:**
- با نام معیار و برنامهٔ تکرکورد، وقتی list دقیق صفر/یک/چند TXT برگرداند، آنگاه بهترتیب create، overwrite یا batch replacement انجام و فقط `created` یا `updated` با شناسهٔ قابل اثبات برگردانده شود.
- با هر فراخوانی کلودفلر، وقتی درخواست بررسی شود، آنگاه URL، method، query، Bearer header و JSON body دقیق قرارداد رسمی باشند و هیچ شبکهٔ واقعی استفاده نشود.
- با mismatch نام/ناحیه یا ورودی runtime نامعتبر، وقتی replace فراخوانی شود، آنگاه پیش از fetch با `unsafe_target` رد شود.
- با خطای ارائهدهنده یا نتیجهٔ نامعلوم mutation، وقتی خطا مشاهده شود، آنگاه فقط کد نوعمند مستقل از کلودفلر آشکار شود و token، wire و متن پاسخ در message/cause/log ظاهر نشوند.
- مجموعهٔ کامل قبلی و چهار دروازهٔ پروژه بدون regression عبور کنند.

## گزارش تغییر مشخصات

- `src/application/record-store.ts` — قرارداد درگاه، نتیجههای `created`/`updated` و خطاهای نوعمند مستقل از ارائهدهنده افزوده شد.
- `src/adapters/cloudflare-record-store.ts` — سازگارکنندهٔ REST با list/create/PUT/batch، Bearer auth، کنترل مقصد و parsing دفاعی افزوده شد.
- `test/cloudflare-record-store.test.ts` — ۴۱ آزمون fetch جعلی برای قرارداد دقیق و مسیرهای خطا افزوده شد.

## گزارش پالایش بازبینی

- دور ۱: در پاسخ mutation، تطابق `name`، `content`، `ttl` و شناسهٔ update اکنون اثبات میشود؛ پاسخ batch نیز همهٔ حذفها، یکتایی حذفها، یک post معتبر و متفاوتبودن شناسهٔ تازه از شناسههای حذفشده را اثبات میکند.
- دور ۱: پوشش آزمون برای مرزهای دقیق TTL/۲۵۵/۴۰۹۶، خطای list، escaping و حالتهای منفی batch گسترش یافت.
- دور ۱: یافتههای همزمانی/retry/composition رد شدند چون صریحاً متعلق به داستانهای ۱.۷/۱.۸ یا خارج از مرز این داستاناند؛ هیچ اتصال واقعی طبق دستور انجام نشد.
- دور ۲: بازبینی جایگزین Hermes دو نقص قرارداد رسمی را یافت و اصلاح شد: `total_count` کل ناحیه الزاماً برابر نتیجهٔ فیلتر نیست، و TTL معتبر شامل auto=`1` و حداقل Enterprise=`30` است.
- لایهٔ Claude CLI بهعلت OAuth لغوشده اجرا نشد؛ بازبینیهای context-free Hermes، edge-case، verification-gap و بازبینی نهایی Hermes جایگزین آن شدند.

## یادداشتهای طراحی

پرسوجوی list باید `type=TXT`، `name.exact=<fqdn>`, `page=1` و `per_page=100` داشته باشد و پاسخ صفحهای بزرگتر از ظرفیت یا `total_pages>1` را بهجای جایگزینی ناقص رد کند. رکوردهای برگشتی دوباره از نظر type/name بررسی میشوند. برای چند رکورد، endpoint batch با ترتیب قراردادی Cloudflare همهٔ شناسهها را delete و یک TXT را post میکند؛ موفقیت فقط با پاسخ ساختاری معتبر و شناسهٔ رکورد تازه اعلام میشود.

## راستیآزمایی

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npx wrangler deploy --dry-run`

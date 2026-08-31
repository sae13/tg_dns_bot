---
title: 'داستان ۱.۷: ترتیب ارسالهای همزمان و محدودسازی نرخ'
type: 'feature'
created: '2026-08-30'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** Worker فعلی فرمان معتبر را مستقیماً به یک درگاه placeholder میدهد؛ بنابراین دو isolate میتوانند همان update را دوبار اجرا کنند، ارسالهای یک صندوق همپوشان شوند و هیچ حفاظت اتمی برای سهمیهٔ کاربر/صندوق وجود ندارد.

**رویکرد:** یک Durable Object برای هر نام معیار صندوق بساز که update تلگرام را در storage پایدار idempotent کند، پذیرش دو سهمیه را اتمی انجام دهد و اجرای publish موجود را با شمارهٔ ترتیبی افزایشی در همان object سریال کند. Worker پس از احراز webhook و اعتبارسنجی فرمان، درخواست کامل را به object نامگذاریشده با صندوق route کند.

## مرزها و محدودیتها

**همیشه:** `idFromName(mailbox)` تنها مسیر مالکیت صندوق باشد؛ update فقط پس از پایان موفق عملیات processed شود تا تحویل شکستخورده قابل retry بماند؛ شمارهٔ ترتیبی و updateهای پردازششده در storage باشند؛ نرخ پنجرهٔ لغزان با زمان ذخیرهشده، ظرفیت پیشفرض کاربر ۵ و صندوق ۳ در ۶۰ ثانیه داشته باشد؛ رد یکی از سهمیهها هیچکدام را مصرف نکند؛ ورودیهای قدیمیتر از دو پنجره حذف شوند؛ publish از `publishMessage` داستان ۱.۶ reuse شود و حداکثر یک اجرای فعال در هر object وجود داشته باشد.

**هرگز:** قفل، dedup یا سهمیهٔ معتبر در حافظهٔ Worker، Durable Object سراسری برای همهٔ صندوقها، اتصال واقعی، retry/reconciliation نتیجهٔ نامعلوم داستان ۱.۸، پاسخ Bot API، deployment، commit یا ویرایش مشخصات منجمد قبلی وارد نشود. payload نامعتبر object نباید mutation DNS یا storage پذیرش بسازد.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی / حالت | رفتار مورد انتظار | مدیریت خطا |
|---|---|---|---|
| همزمانی همان صندوق | دو update متمایز با سد publish | sequence افزایشی، FIFO و بدون همپوشانی؛ commit دوم آخرین پیام | شکست هر درخواست فقط همان update را قابل retry نگه دارد |
| صندوقهای متفاوت | دو نام معیار متفاوت | objectهای مستقل و امکان پیشرفت همزمان | قفل مشترک ساخته نشود |
| update تکراری | همان `update_id` پس از restart object | publish و مصرف سهمیه تکرار نشود | پاسخ `duplicate` پایدار |
| محدودیت کاربر/صندوق | ظرفیت یکی پر و دیگری آزاد | رد پیش از publish همراه `retryAfterSeconds` | هیچ timestamp تازه در هیچ سهمیه نوشته نشود |
| پایان پنجره | ساعت جلو رفته و state بیکار است | پذیرش دوباره و حذف bucketهای کهنه | زمان برگشتی منفی نباشد |

</frozen-after-approval>

## نقشهٔ کد

- `src/domain/telegram-update.ts` — parsing موجود باید `from.id` و `from.username` را برای هویت پیام و کلید rate بدون وابستگی Workers حمل کند.
- `src/application/handle-update.ts` — `SendRequest` با `updateId`، sender و metadata لازم گسترش و همچنان فقط پس از اعتبارسنجی mailbox به port داده شود.
- `src/application/publish-message.ts` — سرویس انتشار stage→commit→cleanup موجود؛ فقط reuse و بدون تغییر معناشناسی.
- `src/domain/managed-message.ts` و `src/domain/publish-plan.ts` — factoryهای موجود برای ساخت plan داخل coordinator؛ reuse.
- `src/adapters/cloudflare-record-store.ts` — adapter موجود با fetch تزریقی/محیطی؛ composition coordinator آن را میسازد.
- `src/durable-objects/mailbox-coordinator.ts` — مالک تازهٔ storage dedup/sequence/rate، FIFO execution و composition publish.
- `src/index.ts` — routing پیشفرض `SendRequestPort` به `COORDINATOR.idFromName(mailbox)`؛ injection قدیمی آزمونها حفظ شود و class DO export گردد.
- `src/config.ts` و `wrangler.toml` — bindings و ظرفیت/پنجره/TTL/API token نوعمند و migration Durable Object.
- `test/mailbox-coordinator.test.ts` و `test/worker-coordinator-routing.test.ts` — آزمون runtime واقعی Miniflare برای serialization، restart idempotency، rate و routing؛ همهٔ fetchها mock.

## کارها و پذیرش

**اجرا:**
- [ ] `test/mailbox-coordinator.test.ts` سپس `src/durable-objects/mailbox-coordinator.ts` — tracer عمودی FIFO/sequence و reuse `publishMessage` را قرمز/سبز کن.
- [ ] همان فایل — dedup پایدار موفق/شکست و restart-style object eviction را با storage واقعی پوشش بده.
- [ ] همان فایل سپس `src/config.ts` — پذیرش اتمی sender/mailbox، retry-after، مرز پنجره و cleanup دوپنجرهای را پیاده و آزمون کن.
- [ ] `test/worker-coordinator-routing.test.ts` سپس `src/index.ts`، `wrangler.toml` و typeهای update/request — route صندوق معیار به object متناظر و payload کامل را با Worker runtime ثابت کن.

**معیارهای پذیرش:**
- با رقابت تکرارشوندهٔ دو درخواست همان صندوق، وقتی publish پشت سد مشاهده میشود، آنگاه sequenceها به ترتیب ورود، active count حداکثر یک و پیام دوم آخرین commit است.
- با دو صندوق، وقتی اولی پشت سد متوقف است، آنگاه دومی بدون انتظار وارد publish میشود.
- با update موفق و eviction/reload نمونهٔ object، وقتی همان update دوباره میرسد، آنگاه `duplicate` برمیگردد و هیچ publish یا مصرف نرخ دوباره رخ نمیدهد.
- با پرشدن هر bucket، وقتی درخواست بعدی میرسد، آنگاه پیش از mutation رد، retry-after تقریبی اعلام و bucket آزاد مصرف نمیشود.
- مجموعهٔ قبلی و چهار دروازهٔ پروژه بدون regression عبور کنند.

## گزارش تغییر مشخصات

## گزارش پالایش بازبینی

- یافتهٔ پایداری: نتیجههای نوعمند `not_committed` و `commit_unknown` نباید processed شوند؛ pending با همان sequence، timestamp، payload و message UUID برای retry حفظ شد.
- یافتهٔ یکپارچگی: استفادهٔ دوباره از `update_id` با payload متفاوت اکنون fail-closed است.
- یافتهٔ routing: پاسخ rate-limit از object در Worker acknowledge میشود تا Telegram همان update ردشده را بیپایان retry نکند؛ شکست publish همچنان retryable میماند.
- آزمونهای mutation/مرزی برای همپوشانی، restart storage، rollback ساعت، سهمیهٔ نیمهکاره، retry typeمند و routing افزوده شدند.

## یادداشتهای طراحی

هر object با کلید صندوق ساخته میشود و در همان تراکنش storage، bucket آن صندوق و bucketهای شناسههای فرستندهٔ حاضر در آن صندوق را نگه میدارد؛ در نتیجه بررسی و مصرف دو سهمیه اتمی است و صندوقهای متفاوت مستقل میمانند. این همان مرز هماهنگی per-mailbox الزامشدهٔ داستان است؛ ساخت coordinator سراسری یا پروتکل چند-object خارج از محدوده است.

## راستیآزمایی

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npx wrangler deploy --dry-run`

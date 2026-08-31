---
title: 'داستان ۱.۶: انتشار امن پیام چندقطعهای'
type: 'feature'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** برنامهٔ چندرکوردی داستان ۱.۴ هنوز orchestration امنی ندارد؛ overwrite قطعههای شمارهدار پیش از root میتواند پیام قبلی را ناقص کند و شکست پس از commit نیز قطعههای قدیمی را باقی میگذارد.

**رویکرد:** قطعههای شمارهدار تازه را با حفظ نسخههای قبلی stage کن، root را فقط پس از پایان همهٔ stageها جایگزین کن و سپس RRsetهای شمارهدار جاری را collapse و نامهای اضافی را حذف کن. بدهی پاکسازی از root جاری و inventory کلودفلر، بدون صف محلی، دوباره مشتق شود.

## مرزها و محدودیتها

**همیشه:** root تنها نقطهٔ commit و آخرین mutation پیش از پاکسازی است؛ شکست stage هرگز root را تغییر نمیدهد؛ موفقیت commit حتی با شکست cleanup نتیجهٔ نوعمند موفق-با-بدهی میدهد؛ عملیات cleanup تکرارپذیر است؛ reconciliation فقط قطعههای سازگار با شناسه و metadata root جاری را نگه میدارد و در ابهام destructive عمل نمیکند.

**هرگز:** retry/reconciliation نتیجهٔ نامعلوم داستان ۱.۸، ترتیب همزمانی داستان ۱.۷، خوانندهٔ عمومی داستان ۲، اتصال واقعی، deployment، composition root، تغییر codec/publish-plan یا مشخصات منجمد داستانهای قبلی وارد نشود. API ارائهدهنده، payload و رازها در نتیجه/خطا آشکار نشوند.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی / حالت | رفتار مورد انتظار | مدیریت خطا |
|---|---|---|---|
| انتشار کامل | برنامهٔ چندرکوردی معتبر | add قطعههای ۲..n، replace root، collapse قطعههای جاری، حذف نامهای >n | `committed` |
| شکست stage | شکست هر قطعهٔ شمارهدار | root فراخوانی نشود و پیام قبلی قابل انتخاب بماند | `not_committed` نوعمند و بدهی قابل مشتق |
| commit نامعلوم | mutation root نتیجهٔ نامعلوم دهد | موفقیت ادعا نشود | `commit_unknown` |
| شکست cleanup | root موفق، collapse/delete ناموفق | commit باطل نشود و همهٔ cleanupهای مستقل امتحان شوند | `committed_cleanup_pending` با failureهای امن |
| بازیابی | root جاری و inventory شامل orphan/stale | فقط یک قطعهٔ یکتای سازگار در هر index نگه داشته و نام اضافی حذف شود | ابهام/فقدان بدون حذف و با نتیجهٔ نوعمند |

</frozen-after-approval>

## نقشهٔ کد

- `src/domain/publish-plan.ts` — شکل معتبر `PublishPlan`، ترتیب root سپس نامهای `2.<root>` و payloadهای نهایی؛ فقط reuse و بدون تغییر.
- `src/application/record-store.ts` — درگاه موجود replace و خطاهای امن؛ با add/read/inventory/delete سطح مجموعه گسترش یابد و رفتار موجود حفظ شود.
- `src/adapters/cloudflare-record-store.ts` — fetch تزریقی و اعتبارسنجی مقصد موجود؛ قراردادهای تازهٔ add، read دقیق، inventory شمارهدار و delete RRset را مالک شود.
- `src/application/publish-message.ts` — orchestration تازه برای stage→root commit→cleanup و reconciliation مشتقشدنی با unionهای نتیجهٔ بسته.
- `test/publish-message.test.ts` — fake store حافظهدار و تزریق شکست در هر mutation برای اثبات پیام قبلی/جدید، ترتیب root-last و retry پاکسازی.
- `test/cloudflare-record-store.test.ts` — قرارداد HTTP عملیات تازه، pagination، parsing TXT، mismatch و خطاهای نامعلوم؛ fetch واقعی ممنوع.

## کارها و پذیرش

**اجرا:**
- [x] `test/publish-message.test.ts` سپس `src/application/publish-message.ts` — آزمونهای قرمز نقاط شکست و unionهای نتیجه را عمودی پیاده کن.
- [x] `test/cloudflare-record-store.test.ts` سپس `src/application/record-store.ts` و `src/adapters/cloudflare-record-store.ts` — عملیات لازم برای staging و cleanup را با قرارداد HTTP دفاعی اضافه کن.
- [x] هر دو فایل آزمون — restart-style reconciliation، cleanup idempotent، چند ID، صفحههای inventory و عدم نشت داده را پوشش بده.

**معیارهای پذیرش:**
- با هر شکست پیش از root، وقتی trace درگاه بررسی میشود، آنگاه هیچ replace روی root وجود ندارد و snapshot خواندنی root قبلی با قطعهٔ همشناسه همچنان قابل انتخاب است.
- با stage موفق، وقتی root ثبت میشود، آنگاه آخرین mutation پیش از cleanup همان root است و فقط موفقیت آن `committed` محسوب میشود.
- با شکست هر cleanup، وقتی خروجی بررسی میشود، آنگاه نتیجه `committed_cleanup_pending` است، cleanupهای مستقل بعدی نیز اجرا شدهاند و اجرای دوباره از DNS state بدهی را رفع میکند.
- با manifest جاری و inventory مختلط، وقتی reconciliation اجرا میشود، آنگاه فقط wire یکتای کاملاً سازگار نگه داشته، نامهای index بالاتر حذف و دادهٔ مبهم دستنخورده میماند.
- مجموعهٔ قبلی و چهار دروازهٔ پروژه بدون regression عبور کنند.

## گزارش تغییر مشخصات

- `src/application/record-store.ts` — درگاه با append، read exact، inventory شمارهدار و حذف کامل RRset گسترش یافت.
- `src/application/publish-message.ts` — انتشار stage→root commit→cleanup، نتایج شکست جزئی و reconciliation مشتقشدنی افزوده شد.
- `src/adapters/cloudflare-record-store.ts` — عملیات تازه با کنترل مقصد، pagination، parsing TXT و اثبات پاسخ mutation پیاده شد.
- `test/publish-message.test.ts` و `test/cloudflare-record-store.test.ts` — تزریق شکست همهٔ stageها، commit، cleanup، restart و قرارداد HTTP پوشش داده شد.

## گزارش پالایش بازبینی

- بازبینی مستقل Hermes یک خطای طبقهبندی 5xx پس از mutation و یک شکاف تطابق metadata قطعهها با root یافت؛ هر دو با آزمون قرمز و اصلاح پیادهسازی بسته شدند.
- یافتهٔ پوشش ضعیف متناظر با هر دو نقص با آزمونهای mutation-sensitive برای 5xx و metadata ناسازگار بسته شد.

## یادداشتهای طراحی

Stage باید `POST` یک TXT تازه روی نام شمارهدار باشد، نه replace کل RRset؛ در نتیجه root قدیمی هنوز میتواند قطعههای همشناسهٔ خود را میان رکوردهای همنام انتخاب کند. پس از commit، replace دقیق قطعههای برنامه RRsetها را به نسخهٔ جاری collapse میکند. reconciliation پس از restart root را decode، indexهای inventory را استخراج و فقط در صورت وجود یک wire یکتای سازگار mutation میکند.

## راستیآزمایی

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npx wrangler deploy --dry-run`

## ترتیب پیشنهادی بازبینی

**معناشناسی انتشار و بازیابی**

- نقطهٔ ورود stage، commit ریشه و cleanup با خروجیهای نوعمند.
  [`publish-message.ts:55`](../../../src/application/publish-message.ts#L55)

- بازسازی بدهی پاکسازی فقط از root و inventory جاری.
  [`publish-message.ts:138`](../../../src/application/publish-message.ts#L138)

- رد برنامهٔ ناسازگار پیش از هر اثر جانبی.
  [`publish-message.ts:299`](../../../src/application/publish-message.ts#L299)

**مرز کلودفلر**

- staging بدون overwrite، خواندن exact، inventory و حذف idempotent.
  [`cloudflare-record-store.ts:85`](../../../src/adapters/cloudflare-record-store.ts#L85)

- تفکیک خطای قطعی 4xx از نتیجهٔ نامعلوم 5xx mutation.
  [`cloudflare-record-store.ts:276`](../../../src/adapters/cloudflare-record-store.ts#L276)

**قرارداد و آزمونها**

- عملیات سطح RRset و نتیجههای مستقل از ارائهدهنده.
  [`record-store.ts:31`](../../../src/application/record-store.ts#L31)

- تزریق شکست همهٔ stageها، commit، cleanup و restart.
  [`publish-message.test.ts:31`](../../../test/publish-message.test.ts#L31)

- قرارداد HTTP، pagination، TXT parsing و پاسخهای مبهم.
  [`cloudflare-record-store.test.ts:75`](../../../test/cloudflare-record-store.test.ts#L75)

---
title: 'داستان ۱.۸: تلاش مجدد محدود و تطبیق پایدار انتشار'
type: 'feature'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## هدف

**مسئله:** شکست موقت یا قطع ارتباط پس از mutation اکنون میتواند نتیجهٔ واقعی انتشار را مبهم بگذارد؛ coordinator فقط pending را حفظ میکند اما بدون درخواست تازه بازیابی پایدار ندارد و adapter نیز retry، timeout و بودجهٔ کراندار ندارد.

**رویکرد:** retry هر فراخوانی منفرد را فقط در adapter کلودفلر با سیاست قطعی و قابل تزریق اجرا کن؛ `publishMessage` نتیجهٔ mutation مبهم را با بازخوانی و شناسهٔ همان پیام تطبیق دهد؛ و `MailboxCoordinator` کار حلنشده را در storage نگه دارد و با alarm پس از restart ادامه دهد.

## مرزها و محدودیتها

**همیشه:** حداکثر سه تلاش برای خطای شبکه، 429 و 5xx با فاصلههای پایهٔ ۲ و ۴ ثانیه بهعلاوهٔ jitter؛ timeout هر فراخوانی ۱۵ ثانیه و بودجهٔ کل انتشار ۴۵ ثانیه؛ خطای 4xx اعتبارسنجی/مجوز terminal و بدون retry؛ mutation مبهم پیش از تکرار با خواندن دقیق همان نام و تطبیق message id بررسی شود؛ ادامه فقط همان مرحلهٔ اثباتنشده را با همان message id انجام دهد؛ pending، مرحلهٔ تطبیق و زمان alarm در storage پایدار باشند؛ گزارش ساختیافته فقط correlation id، عملیات، مدت، نتیجه و نوع خطا داشته باشد.

**هرگز:** retry کل `publishMessage` از ابتدا، ساخت UUID یا مصرف سهمیهٔ دوباره، اتکا به timer درونحافظه، اتصال واقعی، deployment، commit، افشای token یا متن کامل پیام، تغییر قرارداد codec/plan یا ویرایش مشخصات منجمد داستانهای پیشین انجام نشود.

## ماتریس ورودی، خروجی و لبهها

| سناریو | ورودی / حالت | رفتار مورد انتظار | مدیریت خطا |
|---|---|---|---|
| شکست موقت پیش از mutation | شبکه، 429 یا 5xx | تلاشهای حداکثر ۳ با delay پایهٔ ۲/۴ ثانیه و jitter | پس از کران، خطای نوعمند و pending پایدار |
| خطای terminal | 400/401/403 یا درخواست نامعتبر | همان تلاش نخست متوقف میشود | پیام امن و بدون راز؛ alarm بیپایان ساخته نشود |
| stage مبهم | قطع پس از append قطعه | exact-name reread؛ قطعهٔ همان message id موفق محسوب و مرحلهٔ بعد اجرا میشود | نبود قطعه فقط یک ادامهٔ mutation؛ دادهٔ متعارض pending میماند |
| commit مبهم | قطع پس از تعویض root | root reread؛ همان message id موفق و cleanup اجرا میشود | root قدیمی/غایب فقط طبق state پایدار ادامه مییابد؛ ابهام حلنشده alarm میگیرد |
| پایان بودجه یا restart | pending ذخیرهشده و ۴۵ ثانیه مصرفشده | پاسخ طبقهبندیشده و alarm؛ نمونهٔ تازه همان state را ادامه میدهد | sequence، پذیرش و UUID تغییر نمیکنند |

</frozen-after-approval>

## نقشهٔ کد

- `src/adapters/cloudflare-record-store.ts` — مالک همهٔ fetchهای کلودفلر؛ محل retry/timeout/jitter، تشخیص 429/5xx در برابر 4xx و گزارش امن؛ clock/sleep/random/fetch/logger قابل تزریق برای آزمون قطعی.
- `src/application/record-store.ts` — کدهای خطای نوعمند لازم برای terminal، timeout و پایان بودجه بدون حمل body یا راز.
- `src/application/publish-message.ts` — state machine انتشار stage→commit→cleanup؛ محل تطبیق exact-name با message id و ادامهٔ همان مرحله، نه تکرار تراکنش.
- `src/durable-objects/mailbox-coordinator.ts` — pending موجود شامل request/sequence/UUID؛ آن را با وضعیت reconciliation و alarm پایدار گسترش میدهد و success را اتمی processed میکند.
- `src/config.ts` و `wrangler.toml` — binding نوعمند `PROVIDER_TIMEOUT_SECONDS` و بودجهٔ ثابت/پیکربندی معتبر ۴۵ ثانیه.
- `test/cloudflare-record-store.test.ts` — fake clock/fetch برای تعداد تلاش، jitter/backoff، timeout، بودجه، terminal status و redaction.
- `test/publish-message.test.ts` — stage/commit پس از mutation، بازخوانی شناسه، نبود duplicate و partial publication.
- `test/mailbox-coordinator.test.ts` — alarm واقعی Miniflare، persistence پس از ساخت instance تازه، terminal failure و تکمیل pending بدون پذیرش دوباره.

## کارها و پذیرش

**اجرا:**
- [x] `test/cloudflare-record-store.test.ts` سپس `src/adapters/cloudflare-record-store.ts` و `src/application/record-store.ts` — retry کراندار، deadline، timeout، jitter و logging امن را قرمز/سبز کن.
- [x] `test/publish-message.test.ts` سپس `src/application/publish-message.ts` — تطبیق stage و commit مبهم و ادامهٔ تکمرحلهای را بدون تکرار کور ثابت کن.
- [x] `test/mailbox-coordinator.test.ts` سپس `src/durable-objects/mailbox-coordinator.ts` — state پایدار و alarm برای retry/reconciliation را با restart واقعی پوشش بده.
- [x] `test/config.test.ts` سپس `src/config.ts` و `wrangler.toml` — کرانهای timeout و بودجه را نوعمند و fail-closed کن.

**معیارهای پذیرش:**
- با دو شکست موقت و سپس موفقیت، وقتی یک فراخوانی کلودفلر اجرا میشود، آنگاه دقیقاً سه fetch با delayهای پایهٔ ۲ و ۴ ثانیه بهعلاوه jitter رخ میدهد و publish در لایهٔ کاربرد دوباره آغاز نمیشود.
- با پاسخ مجوز/اعتبارسنجی، وقتی adapter آن را میبیند، آنگاه یک fetch، خطای terminal امن و بدون alarm تکرارشونده حاصل میشود.
- با commit یا stage واقعی و پاسخ گمشده، وقتی تطبیق اجرا میشود، آنگاه message id موجود موفق شناخته میشود و هیچ RR تکراری ساخته نمیشود.
- با بودجهٔ تمامشده یا restart object، وقتی alarm اجرا میشود، آنگاه pending با همان sequence/UUID از storage ادامه مییابد و نتیجهٔ قطعی اتمی processed میشود.
- مجموعهٔ قبلی و چهار دروازهٔ پروژه بدون regression عبور کنند.

## گزارش تغییر مشخصات

## گزارش پالایش بازبینی

## یادداشتهای طراحی

state پایدار باید «مرحلهٔ بعدی لازم» را ثبت کند، نه callback یا Promise را. alarm همان ورودی پذیرفتهشده را از storage میخواند؛ نتیجهٔ موفق pending را حذف و processed را در یک transaction مینویسد، خطای terminal را طبقهبندی و متوقف میکند، و خطای موقت/مبهم حلنشده alarm کراندار بعدی میگیرد. بدهی cleanup همچنان از manifest و inventory مشتق میشود و صف محلی جدا ساخته نمیشود.

## راستیآزمایی

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npx wrangler deploy --dry-run`

## ترتیب پیشنهادی بازبینی

**مالکیت retry و تطبیق**

- سیاست کراندار fetch و logging امن در مرز ارائهدهنده متمرکز است.
  [`cloudflare-record-store.ts:338`](../../src/adapters/cloudflare-record-store.ts#L338)

- انتشار مبهم پیش از ادامه، رکورد همان پیام را تطبیق میدهد.
  [`publish-message.ts:68`](../../src/application/publish-message.ts#L68)

- state machine از تکرار کور stage و commit جلوگیری میکند.
  [`publish-message.ts:81`](../../src/application/publish-message.ts#L81)

**پایداری Durable Object**

- alarm pending پایدار را پس از restart بازیابی و طبقهبندی میکند.
  [`mailbox-coordinator.ts:114`](../../src/durable-objects/mailbox-coordinator.ts#L114)

- composition همان UUID، deadline و مسیر resume را حفظ میکند.
  [`mailbox-coordinator.ts:177`](../../src/durable-objects/mailbox-coordinator.ts#L177)

**تنظیمات و شواهد**

- timeout پانزدهثانیهای و بودجهٔ چهلوپنجثانیهای fail-closed parse میشوند.
  [`config.ts:61`](../../src/config.ts#L61)

- fake clock فاصلههای retry و jitter را قطعی اثبات میکند.
  [`cloudflare-record-store.test.ts:533`](../../test/cloudflare-record-store.test.ts#L533)

- restart و alarm با storage واقعی Miniflare پوشش داده شدهاند.
  [`mailbox-coordinator.test.ts:209`](../../test/mailbox-coordinator.test.ts#L209)

- resume مرحلهٔ مبهم بدون append تکراری آزموده میشود.
  [`publish-message.test.ts:245`](../../test/publish-message.test.ts#L245)

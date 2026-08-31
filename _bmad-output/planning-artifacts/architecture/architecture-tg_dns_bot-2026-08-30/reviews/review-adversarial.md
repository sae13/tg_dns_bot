# بازبینی خصمانهٔ سازگاری واحدهای مستقل

## Verdict

**FAIL — معماری برای شکستن به واحدهای مستقل آماده نیست.** دو تیم میتوانند همهٔ ADها را رعایت کنند و همچنان در قرارداد داده، انتشار چندقطعهای، retry، خواندن و استقرار پیادهسازیهای ناسازگار بسازند. پیش از پیادهسازی باید قراردادهای پاییندستی آزمونپذیر بسته شوند.

## یافتهها

### 1) [HIGH] شکل داده و قرارداد عملیاتی `RecordStorePort` تعریف نشده است

**شاهد:** Spine فقط میگوید قطعهها نوشته، root overwrite و قطعههای قدیمی حذف شوند (`AD-4`، خطوط 65–80) و استفاده از درگاه را به Send محدود میکند (خط 128)، اما امضای عملیات، نوع بازگشت، هویت رکورد، precondition و مدل RRset را مشخص نمیکند. در عین حال PRD میگوید نخستین ارسال باید چند TXT همنام موجود را با یک پیام واحد جایگزین کند (addendum خطوط 50–52).

**ناسازگاری مجاز:** واحد کاربرد میتواند «جایگزینی RRset برحسب نام» بخواهد، ولی adapter کلودفلر «update یک record-id» پیاده کند؛ یا یکی چند رکورد ناشناس را حذف کند و دیگری فقط یک رکورد را update کند. هر دو ظاهراً AD-3/4/5 را رعایت میکنند.

**بستن شکاف:** DTOهای immutable و عملیات دقیق port را تعریف کنید: `read_managed_state/put_chunk/commit_root/delete_chunk` یا معادل آن، کلیدهای `zone_id/name/type/record_id`، سیاست TXTهای همنام، pre/postcondition، و taxonomy نتیجه (`created/updated/not_found/conflict/ambiguous`). قرارداد fake و contract test مشترک اجباری شود.

### 2) [HIGH] wire format و مرز codec/serializer هنوز قرارداد مشترک نیست

**شاهد:** `AD-6` فقط فیلدها و UTF-8 را الزام میکند (خطوط 88–92) و شکل دقیق سریالسازی صریحاً واگذار شده است (خط 195). addendum نیز همزمان سقف 255 بایت برای هر character-string، سقف انتقالی رکورد، escape و سپردن تقسیم داخلی به serializer را مطرح میکند (خطوط 23–27). مشخص نیست root چگونه هم manifest و هم «قطعهٔ نخست» است، canonical encoding چیست، و چند character-string در پاسخ DNS چگونه دوباره متصل میشوند.

**ناسازگاری مجاز:** codec میتواند JSON/Base64 یا متن escapeشده تولید کند، درحالیکه adapter رشتههای TXT را با `""`، فاصله، یا بدون جداکننده join کند؛ محاسبهٔ ظرفیت نیز ممکن است قبل یا بعد از quoting انجام شود. round-trip داخلی هر واحد پاس میشود ولی دادهٔ واقعی بین آنها خراب میشود.

**بستن شکاف:** یک wire specification نسخهدار با بایتهای canonical، magic prefix، encoding فیلدها، escaping، ترتیب و معنای character-stringها، محتوای دقیق root/chunk، الگوریتم chunk budget و golden vectors فارسی/emoji/quote/backslash تعریف کنید. مالک split/join داخلی TXT را دقیقاً یک لایه کنید.

### 3) [HIGH] ownership تغییر، ترتیب پذیرش و عمر قفل برای «آخرین ارسال» کافی نیست

**شاهد:** `AD-3` سریشدن در یک پردازه با کلید نام معیارشده را میخواهد (خطوط 59–63)، ولی PRD میگوید «آخرین ارسال کامل» برنده باشد (خط 109). نقطهٔ تعیین ترتیب—ورود update تلگرام، ورود use case، اخذ قفل یا commit—مشخص نیست؛ cancellation، timeout هنگام انتظار، reentrancy و حذف lockهای mailbox نیز تعریف نشدهاند.

**ناسازگاری مجاز:** adapter تلگرام میتواند handlerها را concurrent و application قفل را FIFO-نامطمئن بگیرد؛ در نتیجه درخواست دیرتر ممکن است زودتر قفل بگیرد و سپس با درخواست قدیمی overwrite شود. پیادهسازی دیگر «آخرین» را برحسب زمان commit تعبیر میکند. هر دو سری هستند اما رفتار محصول متفاوت است.

**بستن شکاف:** linearization point و ترتیب مطلوب را تعریف کنید؛ sequence/admission token در application بسازید؛ lock registry، cancellation و shutdown semantics را مشخص کنید؛ و آزمونهای barrier-based برای دو ارسال، لغو waiter و شکست commit اضافه کنید.

### 4) [HIGH] retry برای writeهای غیراتمی idempotency و reconciliation ندارد

**شاهد:** PRD retry محدود با backoff میخواهد (خط 210) و Spine مقادیر آن را واگذار میکند (خط 196)، اما نمیگوید کدام عملیات retryپذیر است. timeout پس از `create/update/delete` کلودفلر نتیجهٔ نامعلوم میسازد؛ `AD-4` نیز چند mutation جدا دارد.

**ناسازگاری مجاز:** use case کل تراکنش را retry میکند و adapter نیز هر HTTP call را؛ تعداد تلاشها ضرب میشود، create تکراری TXT همنام میسازد، یا timeout commit با ارسال خطا به کاربر همراه میشود درحالیکه root واقعاً منتشر شده است. پیادهسازی دیگر retry نمیکند و رفتار متفاوت دارد.

**بستن شکاف:** مالک یگانهٔ retry، بودجهٔ انتهابهانتها، timeout، jitter و خطاهای retryable را ثبت کنید. برای هر mutation کلید idempotency منطقی/lookup-by-name+message-id و الگوریتم reconcile-after-unknown-outcome تعیین کنید؛ success/error کاربر پس از reconciliation تعریف شود.

### 5) [HIGH] الزام retry پاکسازی با مدل پایداری و restart متناقض است

**شاهد:** PRD میگوید شکست پاکسازی باید «ثبت و قابل تلاش مجدد» باشد (خط 209) و addendum آن را در صف retry میگذارد (خط 48). در مقابل `AD-10` تنها حالت پایدار را DNS میداند (خطوط 112–116) و Spine ذخیرهٔ وضعیت cleanup برای ادامه پس از restart را تا شواهد آینده واگذار میکند (خط 199).

**ناسازگاری مجاز:** یک واحد فقط retry در حافظه میکند و با restart کار را گم میکند؛ واحد دیگر هنگام هر ارسال cleanup میکند؛ سومی state محلی اضافه میکند و AD-10 را نقض میکند. هیچ معیار مشترکی برای «قابل تلاش مجدد» وجود ندارد.

**بستن شکاف:** یکی را قطعی کنید: (الف) cleanup کاملاً derivable و idempotent از root/DNS یا inventory کلودفلر و در startup/ارسال بعدی reconcile شود، یا (ب) persistence کوچک مجاز شود. سقف عمر، cadence، owner و observability backlog را تعریف کنید.

### 6) [HIGH] read semantics میان root، numbered names و TXTهای خام بسته نشده است

**شاهد:** `AD-4` سازگاری شناسه/نسخه/تعداد را میخواهد (خط 69)، `AD-5` خواندن را فقط از DNS عمومی میخواهد (خط 86)، و PRD نمایش همهٔ TXTهای همنام، بیاتکایی به ترتیب، نمایش خام و آشکارکردن محتوای پیام ناقص را الزام میکند (خطوط 151 و 155–163). الگوریتم پرسوجوی نامهای numbered، join کردن character-stringها، انتخاب managed root میان چند TXT، و خروجی دقیق در root جدید + chunk cacheشده/مفقود تعیین نشده است.

**ناسازگاری مجاز:** resolver adapter یک TXT RR را آرایهٔ رشته برگرداند و application هر رشته را رکورد مستقل بداند؛ یا reader نخستین managed root را انتخاب کند درحالیکه دیگری همه را ambiguous بداند. همچنین یکی در صورت chunk مفقود payload موجود را خام نشان میدهد و دیگری metadata-only، هر دو مدعی رعایت FR-8 میشوند.

**بستن شکاف:** `TxtRecord` را بهصورت یک RR با `segments: tuple[bytes]` تعریف کنید و join مالک adapter باشد؛ state machine خواندن (`no-answer/raw/one-managed/ambiguous/incomplete/complete`) و query plan از manifest را مشخص کنید؛ تعداد/نام معتبر قطعهها، mixed-cache behavior و قالب نمایش محتوای موجود را با vectors تثبیت کنید.

### 7) [MEDIUM] schema تنظیمات برای composition مستقل و zone routing ناکافی است

**شاهد:** `AD-7` اعتبارسنجی یکباره، رازهای محیطی، دامنههای معیار و سه flag را الزام میکند (خطوط 94–98)، ولی جز سه نام flag، نام/نوع/default متغیرها، نگاشت allowed suffix به Cloudflare zone، TTL مجاز، timeout/retry/rate parameters و dependencyهای featureها تعریف نشدهاند؛ خود Spine این مقادیر را واگذار کرده است (خطوط 195–197).

**ناسازگاری مجاز:** config یک allowed domain را zone apex فرض کند و adapter دیگری zone-id صریح بخواهد؛ parsing فهرست comma/JSON، boolها، TTL و رفتار `SEND_ENABLED=false` بدون credential میتواند متفاوت باشد. هر دو typed و fail-fast هستند.

**بستن شکاف:** schema کامل env با نام، type، default، bounds و مثال تعریف کنید؛ مدل صریح `allowed_suffix -> zone_id/zone_name`، قواعد IDNA و duplicate/overlap را ببندید؛ validation وابسته به feature را مشخص و contract test startup منتشر کنید.

### 8) [HIGH] rate limit در deployment تکنمونهای enforce نشده و قرارداد دوکلیدی اتمی نیست

**شاهد:** `AD-8` دو کلید sender و mailbox و ممنوعیت چند نمونه را میگوید (خطوط 100–104)؛ `AD-10` نیز graceful shutdown را میخواهد (خط 116)، اما الگوریتم، window/capacity، زمان charge/refund، اتمیبودن بررسی دو کلید، memory eviction و سازوکار جلوگیری از overlap در rolling deploy تعیین نشده است. image/host/delivery نیز واگذار شده (خط 197).

**ناسازگاری مجاز:** limiter ابتدا sender را مصرف و سپس mailbox را رد میکند (سهمیهٔ sender سوخته)، دیگری هر دو را اتمی میگیرد؛ یکی attempt را میشمارد و دیگری success را. در rolling restart دو پردازه موقتاً فعال میشوند و هم قفل mailbox و هم نرخ دو برابر میشوند، با وجود اینکه هر واحد منفرد ADها را رعایت میکند.

**بستن شکاف:** contract اتمی `acquire(sender, mailbox)`، clock، الگوریتم/مقادیر، charge/refund و eviction را تعیین کنید. deployment باید strategy بدون overlap (`Recreate`, replica=1)، termination grace بزرگتر از بودجهٔ عملیات، stop-polling سپس drain، و guard عملیاتی/lease برای اثبات single-active داشته باشد؛ startup/readiness و rollback نیز ثبت شوند.

## جمعبندی شدت

- Critical: 0
- High: 7
- Medium: 1
- Low: 0

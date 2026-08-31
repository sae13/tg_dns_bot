# بستن دروازهٔ بازبینی خصمانه

## Verdict

**PASS — هر هشت یافتهٔ بازبینی قبلی بسته شدهاند.**

- PASS: 8
- FAIL: 0

## ارزیابی یافتهها

| یافتهٔ قبلی | تصمیم اصلاحی مقابل | نتیجه | دلیل بستهشدن |
| --- | --- | --- | --- |
| 1. قرارداد عملیاتی `RecordStorePort` و مدل مجموعهٔ رکورد | `AD-11` | **PASS** | عملیات درگاه در سطح کل مجموعه، سیاست جایگزینی TXTهای همنام، taxonomy نتیجه، مسئولیت تبدیل به شناسههای Cloudflare و الزام contract test مشترک با fake را قطعی میکند. |
| 2. wire format و مرز codec/serializer | `AD-12` | **PASS** | پیشوند و نسخه، JSON معیار و ترتیب کلیدها، Base64URL بدون padding، مالکیت envelope و تقسیم متن، اتصال segmentهای هر RR و golden vectorهای مشترک را مشخص میکند. |
| 3. ترتیب پذیرش، مالکیت تغییر و عمر عملیات ارسال | `AD-13` | **PASS** | sequence در زمان پذیرش، صف FIFO برای هر صندوق، نقطهٔ خطیشدن در commit ریشه و رفتار لغو، timeout و shutdown را تعیین میکند. |
| 4. retry، idempotency و reconciliation نوشتنهای غیراتمی | `AD-14` | **PASS** | مالک یگانهٔ retry، خطاهای retryable و غیرretryable، تعداد و فاصلهٔ تلاشها، timeout و بودجهٔ کل، نتیجهٔ نامعلوم، idempotency و reconciliation با `message-id` را میبندد. |
| 5. retry پاکسازی در مدل بدون پایداری محلی | `AD-15` | **PASS** | بدهی پاکسازی را از manifest و inventory کلودفلر مشتقشدنی و عملیات را idempotent میکند و تلاش مجدد را در ارسال بعدی و پیمایش startup، بدون صف پایدار محلی، الزام میکند. |
| 6. semantics خواندن root، نامهای شمارهدار و TXT خام | `AD-16` | **PASS** | اتصال segmentهای داخل هر RR، بیمعنایی ترتیب RRها، حالتهای قطعی خواندن، قاعدهٔ root یکتا/مبهم، query plan از manifest و خروجی حالت ناقص را مشخص میکند. |
| 7. schema تنظیمات و zone routing | `AD-17` | **PASS** | schema نامدار و کراندار، پیشفرضها، نگاشت صریح suffix به zone-id، رد overlap و duplicate، وابستگی credential به feature و parsing بستهٔ booleanها را تعریف میکند. |
| 8. rate limit دوکلیدی و استقرار تکنمونهای | `AD-18` | **PASS** | پذیرش اتمی sender/mailbox، charge و عدم charge هنگام رد، پنجرهٔ لغزان و ساعت monotonic، ظرفیتها، eviction و استقرار `Recreate` با یک replica و بدون overlap را الزام میکند. |

## نتیجهٔ دروازه

هر هشت ناسازگاری مجاز توصیفشده در بازبینی قبلی با قواعد `AD-11` تا `AD-18` به قراردادهای الزامآور و آزمونپذیر تبدیل شدهاند؛ شکاف باقیماندهای در محدودهٔ همان هشت یافته وجود ندارد.

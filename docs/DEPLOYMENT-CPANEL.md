# POSTYAR — راهنمای استقرار روی cPanel / Passenger

> **مخاطب**: مدیر سرور/سامانه‌دار پُست‌یار که می‌خواهد پروژه را روی یک هاست cPanel با LiteSpeed + Passenger + Node.js 22 + MariaDB 10 + Redis + AutoSSL استقرار دهد.
>
> **شناسه کار**: این سند بر پایهٔ `package.json`، `next.config.ts` (`output: "standalone"`)، `prisma/schema.prisma` (SQLite در dev، MariaDB در prod)، `src/middleware.ts` (HSTS/CSP/X-Frame-Options) و فایل `/api/health` (پایش سرویس) نوشته شده است.
>
> **هرگز**: `bun run build` به‌تنهایی کافی نیست؛ برای استقرار باید اسکریپت `build` در `package.json` را اجرا کنید که `next build` + کپی `.next/static` و `public/` را روی خروجی standalone انجام می‌دهد (سطر ۷ `package.json`).

---

## ۰. پیش‌نیازها

- cPanel 最新版 با **Application Manager** (افزونهٔ `cloudlinux-nodejs` یا `nodejs-selector`).
- **Node.js 22.23.2** به‌عنوان نسخهٔ ران‌تایمِ Passenger.
- **MariaDB 10.x** (از بخش *MySQL® Database Wizard* cPanel ساخته می‌شود).
- **Redis 6+** در صورت پشتیبانی هاست (در غیر این صورت، به‌صورت شرطی از درون‌نامهٔ حافظه‌ای استفاده می‌کنیم — ببینید §۵).
- **AutoSSL** فعال روی دامنهٔ پُست‌یار (برای HSTS ضروری است — `src/middleware.ts` فقط روی HTTPS هدر `Strict-Transport-Security` می‌فرستد).
- بدون دسترسی SSH (تمام کارها از *Terminal* درون cPanel و فایل‌منیجر انجام می‌شود).
- `POSTYAR_MASTER_KEY` (۶۴ هگز ۳۲ بایت) و `POSTYAR_JWT_SECRET` (۳۲+ نویسه) از پیش با `openssl rand -hex 32` ساخته‌شده.

---

## ۱. جایگاه فایل‌ها

ساختار استاندارد که در ادامهٔ این سند استفاده می‌کنیم:

| مسیر | کاربرد |
|------|--------|
| `/home/ACCOUNT/postyar-private/` | **کد منبع اپلیکیشن** — `.next/`، `package.json`، `node_modules/`، `prisma/`، `.env`، `storage/` (رسانه‌های آپلودشده + رسیدها + آواتارها) |
| `/home/ACCOUNT/public_html/` | **public webroot** — فقط فایل‌های عمومی: `manifest.webmanifest`، `robots.txt`، `favicon`، `icons/`، `assets/ads/`، و یک *entry stub* به نام `app.js` که Passenger را به standalone server هدایت می‌کند. |

> **دلیل جداسازی**: فایل‌های خصوصی (`.env`، `storage/`، `prisma/dev.db`) هرگز نباید داخل `public_html` باشند؛ LiteSpeed به‌صورت پیش‌فرض تمام `public_html/` را به‌صورت استاتیک سرو می‌کند.

```text
/home/ACCOUNT/
├── postyar-private/                      ← کد + خروجی standalone
│   ├── .next/standalone/                 ← خروجی `next build` با output: "standalone"
│   │   ├── server.js                     ← فایل ورودی که Passenger اجرا می‌کند
│   │   └── .next/                        ← فایل‌های استاتیک (کپی شده با اسکریپت build)
│   ├── public/                           ← کپی به داخل standalone در زمان build
│   ├── prisma/
│   │   └── schema.prisma
│   ├── storage/                          ← رسانهٔ آپلودی + رسید + آواتار (chmod 700)
│   ├── .env                              ← chmod 600
│   ├── package.json
│   └── node_modules/
└── public_html/                          ← webroot (chmod 750)
    ├── app.js                            ← entry stub Passenger
    ├── manifest/
    │   └── manifest.webmanifest
    ├── robots.txt
    ├── icons/
    │   ├── icon-192.png
    │   └── icon-512.png
    └── assets/
        └── ads/                          ← تصاویر کمپین‌های تبلیغاتی تاییدشده
```

> پوشهٔ `public/fonts/` (Vazirmatn) و `public/assets/ads/` به‌صورت پیش‌فرض در `public/` پروژه هستند؛ با اجرای اسکریپت `build` در `package.json` به‌طور خودکار داخل `.next/standalone/public/` کپی می‌شوند و نیازی به کپی دستی در `public_html` ندارند چون Next.js خودش این مسیر را از standalone سرو می‌کند.

---

## ۲. ساخت MariaDB در cPanel

1. **cPanel → MySQL® Database Wizard**.
2. یک دیتابیس جدید بسازید؛ مثلاً `ACCOUNT_postyar`.
3. یک کاربر بسازید با رمز قوی (۳۲ بایت رندوم از `openssl rand -base64 24`).
4. به کاربر **تمام** امتیازها روی `ACCOUNT_postyar` را بدهید.
5. در فایل `.env` خود (که در §۶ می‌سازیم) خط زیر را قرار دهید:

   ```env
   DATABASE_URL=mysql://ACCOUNT_user:PASSWORD@127.0.0.1:3306/ACCOUNT_postyar
   ```

   - **注意**: `ACCOUNT_` پیشوند اجباری cPanel است؛ نام دیتابیس و کاربر همیشه با نام کاربری اکانت cPanel شروع می‌شود.
   - هاست `127.0.0.1` (نه `localhost`) — MariaDB در cPanel به‌صورت پیش‌فرض فقط روی سوکت محلی یا ۱۲۷.۰.۰.۱ گوش می‌دهد.

6. **Remote MySQL**: اگر Node.js در یک کانتینر جدا اجرا می‌شود و نیاز به دسترسی از راه دور دارید، IP کانتینر را در *cPanel → Remote MySQL®* اضافه کنید. در غیر این صورت نیازی نیست.

### ۲.۱ — سوییچ `provider` در `prisma/schema.prisma`

در توسعه (اینجا) از SQLite استفاده می‌شود:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

در تولید، این فایل را به این شکل تغییر دهید (یا با متغیر محیطی کنترل کنید):

```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

> **توصیهٔ امنیتی**: به‌جای ویرایش دستی `schema.prisma`، از یک کپی با نام `prisma/schema.prod.prisma` استفاده کنید و هنگام build با `prisma generate --schema=prisma/schema.prod.prisma` آن را فعال کنید. این کار از تغییر ناخواسته schema در commit جلوگیری می‌کند.

---

## ۳. ساخت Redis (در صورت پشتیبانی هاست)

۱. **cPanel → Redis® (اگر وجود داشت)**.
۲. یک instance با نام `postyar` بسازید و یک رمز قوی برایش تنظیم کنید.
۳. در `.env`:

   ```env
   POSTYAR_REDIS_URL=redis://default:PASSWORD@127.0.0.1:6379/0
   ```

### ۳.۱ — سوییچ cache به Redis

ساختار فعلی (در `src/lib/security/cache.ts`) یک shim درون‌برنامه‌ای است. نشانگر `isRedis = false` در خط ۱۰۳ همان فایل، نقطهٔ سوییچ است. برای فعال‌سازی Redis:

1. یک کلاینت `ioredis` یا `redis` (نسخهٔ 4+) نصب کنید: `bun add ioredis`.
2. در `src/lib/security/cache.ts` یک شروط اضافه کنید: اگر `process.env.POSTYAR_REDIS_URL` تنظیم شد، از کلاینت Redis استفاده شود؛ در غیر این صورت همان `Map` فعلی.
3. **هشدار مهم**: shim فعلی **process-local** است؛ یعنی اگر Passenger چند فرآیند (Worker) هم‌زمان اجرا کند — که در تنظیمات پیش‌فرض cPanel/LiteSpeed نادر است اما ممکن است در مقیاس بزرگ رخ دهد — rate-limit ها، idempotency cache و lockهای توزیعشده به‌درستی کار نمی‌کنند. **برای production با چند Worker، Redis واقعی الزامی است**.

### ۳.۲ — راه‌اندازی بدون Redis (fall-back)

اگر هاست Redis ندارد:
- متغیر `POSTYAR_REDIS_URL` را تنظیم نکنید.
- shim درون‌برنامه‌ای فعال می‌ماند و برای یک فرآیند Passenger کاملاً کافی است.
- تمام تنظیمات cron در §۹ روی همان فرآیند واحد اجرا می‌شوند و نیازی به هماهنگی چندفرآیندی ندارند.

---

## ۴. ساخت Node.js Application در cPanel

1. **cPanel → Software → Application Manager** (یا *Setup Node.js App* در بعضی تم‌ها).
2. روی **Create Application** کلیک کنید.
3. فیلدها:
   - **Node.js version**: `22.23.2` (یا نزدیک‌ترین ۲۲.x موجود).
   - **Application mode**: `Production`.
   - **Application root**: `/home/ACCOUNT/postyar-private`.
   - **Application URL**: دامنهٔ پُست‌یار (مثلاً `https://postyar.example`).
   - **Application startup file**: `app.js` — باید در `public_html/app.js` باشد (در §۵ می‌سازیم).
   - ** Passenger log file**: `/home/ACCOUNT/logs/passenger.log` (cPanel به‌صورت پیش‌فرض آن را می‌سازد).
4. روی **Save** بزنید (فعلاً Run نکنید).

---

## ۵. ساخت `app.js` (entry stub برای Passenger)

Passenger به یک فایل جاوااسکریپتی نیاز دارد که در فایل `.htaccess` یا در تنظیمات Application Manager به آن ارجاع داده می‌شود. این فایل فقط `next/dist/server/next` را راه‌اندازی می‌کند. مسیر: `/home/ACCOUNT/public_html/app.js`.

```javascript
// /home/ACCOUNT/public_html/app.js
// POSTYAR — Passenger entry stub
//
// این فایل فقط Node.js را به `.next/standalone/server.js` هدایت می‌کند.
// مسیر standalone با اسکریپت `build` در package.json ساخته می‌شود
// (next build + cp -r .next/static .next/standalone/.next/ + cp -r public .next/standalone/).
//
// POSTYAR_MASTER_KEY، POSTYAR_JWT_SECRET، POSTYAR_CRON_SECRET، DATABASE_URL
// و سایر متغیرها از محیط Passenger (Application Manager → Environment tab)
// خوانده می‌شوند — این فایل هرگز رازها را هاردکد نمی‌کند.

process.env.PORT = process.env.PORT || "3000";

// کاربر حقیقی Next.js standalone
// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require("../postyar-private/.next/standalone/server.js");
// standalone server یک http.Server برمی‌گرداند که Passenger آن را handle می‌کند.
module.exports = handler;
```

> **نکتهٔ مهم**: Passenger در حالت Node.js یک فایل ورودی را `require()` می‌کند و منتظر می‌ماند تا یک سرور HTTP برگرداند. خروجی `next build` با `output: "standalone"` یک `server.js` است که `http.Server` برمی‌گرداند. ما آن را `require` می‌کنیم و به Passenger می‌سپاریم.

> **جایگزین**: در بعضی نسخه‌های Passenger می‌توانید به‌جای `app.js` از دستور استارت `node .next/standalone/server.js` در فیلد *Startup command* استفاده کنید (ببینید §۷). در آن حالت به `app.js` نیاز نیست.

### ۵.۱ — `.htaccess` در `public_html/`

اگر Application Manager به‌صورت خودکار `.htaccess` نساخت:

```apache
# /home/ACCOUNT/public_html/.htaccess
Options -Indexes +FollowSymLinks

# ارسال همهٔ درخواست‌های غیراستاتیک به Passenger
RewriteEngine On
RewriteCond %{HTTP_HOST} ^postyar\.example$ [NC]
RewriteRule ^app\.js$ - [L]
RewriteCond %{REQUEST_URI} !^/(robots\.txt|sitemap\.xml|manifest/|icons/|assets/|fonts/)
RewriteRule ^(.*)$ /app.js [L]

# Content-Security-Policy اضافی در سطح وب‌سرور (در صورت نیاز)
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()"
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" env=HTTPS
</IfModule>
```

> **توجه**: HSTS توسط `src/middleware.ts` به‌صورت پیش‌فرض روی HTTPS ارسال می‌شود؛ اما قرار دادن آن در `.htaccess` به‌عنوان پشتیبان (در صورت خروج Next.js از middleware matcher) خوب است. هرگز فقط روی `.htaccess` تکیه نکنید.

---

## ۶. متغیرهای محیطی در cPanel

1. **Application Manager → روی اپ پُست‌یار → Environment tab**.
2. تمام متغیرها را از `.env.example` وارد کنید. حداقل‌های الزامی:

   ```text
   NODE_ENV=production
   POSTYAR_MASTER_KEY=<64-hex-chars-from-openssl-rand-hex-32>
   POSTYAR_JWT_SECRET=<32+-char-secret-from-openssl-rand-hex-32>
   POSTYAR_CRON_SECRET=<strong-random-string-32+-chars>
   DATABASE_URL=mysql://ACCOUNT_user:PASSWORD@127.0.0.1:3306/ACCOUNT_postyar
   POSTYAR_PUBLIC_URL=https://postyar.example
   POSTYAR_PUBLIC_BASE_URL=https://postyar.example
   POSTYAR_TRUST_PROXY=1
   POSTYAR_MAX_VIDEO_MB=50
   ```

   - `POSTYAR_PUBLIC_URL` و `POSTYAR_PUBLIC_BASE_URL` هر دو **باید https:// دامنهٔ واقعی** باشند؛ در غیر این صورت، ثبت وب‌هوک ربات‌ها در `src/lib/bots/register-webhook.ts` در زمان production با throw می‌شود (خط ۴۸).
   - متغیرهای اختیاری (`POSTYAR_REDIS_URL`، `POSTYAR_AI_*`، `POSTYAR_SMS_*`، `POSTYAR_BANK_*`، `POSTYAR_SMTP_*`، `POSTYAR_GOLD_PROVIDER_URL`) را بنا به نیاز اضافه کنید.

3. **همچنین** یک فایل `.env` فیزیکی در `/home/ACCOUNT/postyar-private/.env` با همان محتوا بسازید. Passenger متغیرهای Application Manager را به `process.env` تزریق می‌کند، اما اسکریپت‌های Prisma و ابزارهای command-line (مثل `prisma migrate deploy`) به `process.env` دسترسی ندارند مگر اینکه `.env` وجود داشته باشد (Prisma آن را به‌صورت خودکار می‌خواند).

4. **سطح دسترسی**: `chmod 600 /home/ACCOUNT/postyar-private/.env` — فقط صاحب اکانت بتواند بخواندش.

---

## ۷. Build و Migration با cPanel Terminal

1. **cPanel → Advanced → Terminal**.
2. به مسیر اپ بروید:

   ```bash
   cd /home/ACCOUNT/postyar-private
   ```

3. نصب وابستگی‌ها (دقیقاً همان نسخه‌های `bun.lock`):

   ```bash
   bun install --frozen-lockfile
   ```

   - اگر `bun` در Terminal نصب نیست، با `npm install -g bun` آن را نصب کنید، یا از `npm ci` استفاده کنید (سپس در §۴ نقطهٔ Startup را `node` بگذارید).

4. اعتبارسنجی schema:

   ```bash
   bunx prisma validate
   ```

5. **Migration production** — **هرگز** `bun run db:push` (که `prisma db push --accept-data-loss` است) را در production اجرا نکنید. اسکریپت `db:push` فقط برای dev است.

   اگر تا کنون migration موجود است:

   ```bash
   DATABASE_URL=mysql://ACCOUNT_user:PASSWORD@127.0.0.1:3306/ACCOUNT_postyar bunx prisma migrate deploy
   ```

   اگر هنوز migration وجود ندارد (اولین استقرار)، یک baseline بسازید:

   ```bash
   DATABASE_URL=mysql://ACCOUNT_user:PASSWORD@127.0.0.1:3306/ACCOUNT_postyar bunx prisma db push
   # سپس برای حفظ تاریخچه، یک migration اولیه بسازید:
   bunx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql
   ```

6. Build پروژه — از اسکریپت `build` در `package.json` استفاده کنید:

   ```bash
   bun run build
   ```

   این اسکریپت اجرا می‌کند:
   - `next build` (با `output: "standalone"`، خروجی را در `.next/standalone/` می‌ریزد).
   - `cp -r .next/static .next/standalone/.next/` (فایل‌های استاتیک را در standalone قرار می‌دهد).
   - `cp -r public .next/standalone/` (پوشهٔ public را داخل standalone می‌برد تا مسیرهای `/fonts`، `/icons`، `/manifest`، `/assets/ads` قابل دسترس باشند).

7. **تست موضعی** پیش از Runner نهایی (در همان Terminal):

   ```bash
   node .next/standalone/server.js &
   sleep 2
   curl -fsS http://127.0.0.1:3000/api/health
   # باید JSON با checks.app=ok برگرداند
   kill %1
   ```

8. در Application Manager → روی **Run** کلیک کنید. لاگ‌ها در `/home/ACCOUNT/logs/passenger.log` دنبال شود.

---

## ۸. دستور استارت

در فیلد **Application startup command** در Application Manager:

```text
node .next/standalone/server.js
```

یا معادل آن در `app.js` (به‌صورت یک `require` — ببینید §۵).

> **توجه**: اگر در مسیر **startup file** به‌جای `app.js` از `server.js` مستقیم استفاده می‌کنید، مسیر کامل `/home/ACCOUNT/postyar-private/.next/standalone/server.js` را وارد کنید.

---

## ۹. زمان‌بندهای cron در cPanel

**cPanel → Cron Jobs**. فرض: متغیر `POSTYAR_CRON_SECRET` از قبل در `.env` و Application Manager تنظیم شده. متغیر را به‌صورت زیر به cron پاس می‌دهیم (cPanel cron اجازه نمی‌دهد مستقیماً متغیر محیطی بخوانیم؛ آن را در خط فرمان مقداردهی می‌کنیم).

### ۹.۱ — Worker انتشار (هر دقیقه)

```cron
*/1 * * * * SECRET=$(grep -m1 POSTYAR_CRON_SECRET /home/ACCOUNT/postyar-private/.env | cut -d= -f2) && curl -fsS -H "x-postyar-cron-secret: $SECRET" https://postyar.example/api/publish/run
```

> این نقطه پایانی در `src/app/api/publish/run/route.ts` پیاده‌سازی شده. یک تیک `runWorkerOnce(batch)` اجرا می‌کند؛ تا ۵ کار `queued` را می‌گیرد و آن‌ها را به مقصد می‌فرستد (با lock توزیع‌شده در `src/lib/security/cache.ts`).

### ۹.۲ — نظرسنجی روبیکا (هر ۵ دقیقه، اختیاری)

اگر ربات روبیکا فعال دارید:

```cron
*/5 * * * * SECRET=$(grep -m1 POSTYAR_CRON_SECRET /home/ACCOUNT/postyar-private/.env | cut -d= -f2) && curl -fsS -X POST -H "x-postyar-cron-secret: $SECRET" -H "content-type: application/json" -d '{"botId":"<BOT_ID>","lastUpdateId":0}' https://postyar.example/api/bots/incoming/rubika?bid=auto
```

> روبیکا وب‌هوک خروجی ندارد (`src/lib/bots/register-webhook.ts` خط ۲۵۷). این نقطه پایانی در `src/app/api/bots/incoming/rubika/route.ts` long-poll می‌کند و آپدیت‌ها را dispatch می‌کند. برای چند ربات، این cron را برای هر `botId` تکرار کنید.

### ۹.۳ — ارزیابی ربات طلا (هر ۵ دقیقه، اختیاری)

اگر ابزارک ارزیابی ربات طلا در دسترس بود (اکنون **نیست**؛ `evalGoldBots` در `src/lib/providers/gold/bot.ts` تعریف شده اما هنوز به API route متصل نیست). این خط را به‌صورت **اگر روزی endpoint شد** نگه دارید:

```cron
*/5 * * * * SECRET=$(grep -m1 POSTYAR_CRON_SECRET /home/ACCOUNT/postyar-private/.env | cut -d= -f2) && curl -fsS -H "x-postyar-cron-secret: $SECRET" https://postyar.example/api/gold/bot/eval || true
```

> تا زمانی که endpoint ساخته نشود، `curl` با خطای ۴۰۴ برمی‌گردد؛ `|| true` موجب می‌شود cron ایمیل خطا نفرستد. در صورت پیاده‌سازی endpoint، پرچم `|| true` را حذف کنید.

### ۹.۴ — هماهنگی چند Worker

Passenger به‌صورت پیش‌فرض برای یک اپ **یک فرآیند** نگه می‌دارند (مگر در تنظیمات `PASSENGER_MAX_POOL_SIZE` تغییر داده شود). بنابراین تمام cron tickها روی همان فرآیند واحد اجرا می‌شوند و lock درون‌برنامه‌ای کافی است. اگر در آینده `PASSENGER_MAX_POOL_SIZE > 1` تنظیم شد:
- `acquireLock` در `src/lib/security/cache.ts` باید از Redis واقعی استفاده کند (§۳).
- در غیر این صورت، دو فرآیند هم‌زمان می‌توانند یک کار `queued` را بگیرند و آن را **دوباره** منتشر کنند (lockMap process-local است و در فرآیند دوم seen نمی‌شود).

---

## ۱۰. سطح دسترسی فایل‌ها

```bash
# در cPanel Terminal:
chmod 600 /home/ACCOUNT/postyar-private/.env
chmod 700 /home/ACCOUNT/postyar-private/storage
chmod 750 /home/ACCOUNT/public_html
chmod 644 /home/ACCOUNT/public_html/app.js
chmod 644 /home/ACCOUNT/public_html/.htaccess
```

- `.env` باید فقط برای صاحب اکانت قابل خواندن باشد.
- `storage/` شامل رسانهٔ آپلودی و رسید پرداخت‌هاست (`src/lib/storage/index.ts` خط ۲۸: `STORAGE_ROOT = path.resolve(process.cwd(), "storage")`)؛ هرگز از طریق وب در دسترس نباشد. middleware matcher در `src/middleware.ts` مسیر `/storage` را به‌صورت پیش‌فرض نمی‌سازد، اما به‌عنوان احتیاط، دسترسی ۷۰۰ کافی است.
- `public_html/` باید برای LiteSpeed قابل خواندن/اجرا باشد (۷۵۰ کافی است چون صاحب اکانت و گروه LiteSpeed هستند).

---

## ۱۱. HTTPS و AutoSSL

1. **cPanel → SSL/TLS Status → Run AutoSSL**.
2. مطمئن شوید که برای دامنهٔ `postyar.example` گواهی **DV** صادر شده.
3. **تأیید HSTS**: در cPanel → *MultiPHP INI Editor* → مدیر دامنه → مطمئن شوید `expose_php = Off` و `session.cookie_secure = On` (برای cookie نشست که در `src/lib/server/auth.ts` خط ۵۸ `secure: process.env.NODE_ENV === "production"` تنظیم شده).

برای تأیید:

```bash
curl -I https://postyar.example/api/health
# باید شامل این خطوط باشد:
# HTTP/2 200
# strict-transport-security: max-age=31536000; includeSubDomains; preload
# x-content-type-options: nosniff
# x-frame-options: SAMEORIGIN
# referrer-policy: strict-origin-when-cross-origin
# permissions-policy: geolocation=(), microphone=(), camera=(), payment=()
# content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' ...
```

اگر هر یک از این هدرها غایب بود، middleware در `src/middleware.ts` به‌درستی load نشده (بعد از build در standalone بررسی کنید که `_next/static` matcher آن را exclude کرده باشد — مسیر `matcher` در خط ۳۷ فقط فایل‌های عمومی را exclude می‌کند).

---

## ۱۲. Health Check

نقطهٔ پایانی `GET /api/health` در `src/app/api/health/route.ts` تعریف شده. باید JSON زیر برگرداند:

```json
{
  "app": "ok",
  "db": "ok",
  "storage": "ok",
  "queue": "ok",
  "worker": "ok",
  "time": "2025-01-01T00:00:00.000Z",
  "checks": {
    "db": "ok",
    "storage": "ok",
    "queue": "ok",
    "worker": "ok",
    "app": "ok"
  }
}
```

- اگر `db=down` بود → `DATABASE_URL` یا امتیاز کاربر MariaDB را بررسی کنید.
- اگر `storage=down` بود → پوشهٔ `storage/` را با `chmod 700` بسازید (در §۱۰).
- اگر `queue=down` بود → مشکل در `workerQueueDepth()` (در `src/lib/queue/worker.ts`) — لاگ Passenger را ببینید.

نسخهٔ مدیران Only:

```bash
TOKEN=<your-admin-jwt-cookie>
curl -fsS -b "postyar_sid=$TOKEN" https://postyar.example/api/admin/health
```

این نقطه پایانی در `src/app/api/admin/health/route.ts` تعریف شده و امتیاز `admin` می‌خواهد. خروجی شامل وضعیت Redis، AI providerها، SMS، Email، Gold و storage است.

---

## ۱۳. Backup و Restore

برای جزئیات کامل به `docs/BACKUP.md` رجوع کنید. خلاصه:

- **Database**: cPanel → Backups → Download a MySQL Database Backup → دیتابیس `ACCOUNT_postyar`. فایل SQL دانلود می‌شود.
- **Files**: دو پوشه باید take backup شوند:
  - `/home/ACCOUNT/postyar-private/storage/` (رسانه + رسیدها + آواتارها).
  - `/home/ACCOUNT/postyar-private/.env` (تنظیمات).
- **Restore on staging**: SQL را import کنید، پوشه‌ها را کپی کنید، `bunx prisma migrate deploy` بزنید، و سپس `/api/admin/health` را اجرا کنید تا همهٔ چک‌ها OK برگردند.

---

## ۱۴. Migration Process (آپدیت schema)

برای تغییر schema در production:

```bash
cd /home/ACCOUNT/postyar-private

# 1. کد جدید را pull کنید
git pull origin main

# 2. نصب وابستگی‌های جدید (در صورت تغییر package.json)
bun install --frozen-lockfile

# 3. Migration را اعمال کنید
DATABASE_URL=mysql://ACCOUNT_user:PASSWORD@127.0.0.1:3306/ACCOUNT_postyar bunx prisma migrate deploy

# 4. Build دوباره
bun run build

# 5. Restart Application
# در cPanel → Application Manager → روی Restart کلیک کنید
```

> **مهم**: در production **هرگز** از `prisma db push --accept-data-loss` (که اسکریپت `db:push` در `package.json` آن را اجرا می‌کند) استفاده نکنید؛ این دستور در صورت تغییر schema داده‌ها را حذف می‌کند. همیشه از `prisma migrate deploy` با migrationهای نسخه‌بندی‌شده استفاده کنید.

---

## ۱۵. URLهای Webhook برای Telegram/Bale

شکل URL:

```text
https://postyar.example/api/bots/incoming/telegram?bid=<BOT_ID>&sig=<HMAC>
https://postyar.example/api/bots/incoming/bale?bid=<BOT_ID>&sig=<HMAC>
```

- `bid` شناسهٔ ربات در جدول `Bot` است.
- `sig` امضای HMAC-SHA256 با لیبل `"bot-webhook-sig"` روی `botId` است (`src/lib/bots/register-webhook.ts` خط ۶۰: `makeWebhookSig`). این مقدار **شناسهٔ ربات را اصالت‌سنجی می‌کند اما توکن ربات را لو نمی‌دهد**.
- اصالت‌سنجی واقعی به این شکل است:
  - در Telegram: هدر `X-Telegram-Bot-Api-Secret-Token` با `bot.webhookSecret` (که در زمان register در `Bot.webhookSecret` به‌صورت رمزنگاری‌شده ذخیره می‌شود) مقایسه می‌شود — به‌صورت constant-time.
  - در Bale: HMAC بدنهٔ خام با کلید `bot.webhookSecret` دوباره محاسبه و با هدر `X-Bale-Webhook-Signature` مقایسه می‌شود.
  - در هر دو، در صورت نبود هدر، به fallback `x-postyar-body-sig` متوسل می‌شویم (برای نظرسنجی داخلی).
  - اگر هیچ امضایی صحیح نبود، با کد ۲۰۰ ولی بدون پرداخت داخلی جواب می‌دهیم تا Telegram/Bale retry نکنند.

> این URLها به‌صورت خودکار در زمان `POST /api/bots/[id]/activate` با `setWebhook` در `src/lib/bots/register-webhook.ts` ثبت می‌شوند؛ نیازی به تنظیم دستی در Telegram/Bale نیست.

---

## ۱۶. فهرست نهایی استقرار

پیش از اعلام "استقرار کامل":

- [ ] MariaDB ساخته شد و `DATABASE_URL` در `.env` و Application Manager تنظیم شد.
- [ ] `bun run build` بدون خطا اجرا شد و `.next/standalone/server.js` وجود دارد.
- [ ] `bunx prisma migrate deploy` اجرا شد (نه `db:push`).
- [ ] `app.js` در `public_html/` ساخته شد (یا Startup command به standalone server.js اشاره می‌کند).
- [ ] Application Manager: **Run** کلیک شد.
- [ ] `chmod 600 .env` و `chmod 700 storage/` اجرا شد.
- [ ] AutoSSL صادر شد و `curl -I https://postyar.example/api/health` شامل `strict-transport-security` است.
- [ ] `/api/health` همهٔ چک‌ها `ok` برمی‌گرداند.
- [ ] `/api/admin/health` (با session admin) همهٔ چک‌ها `ok` برمی‌گرداند.
- [ ] Cronهای §۹ تنظیم شدند و لاگ `/home/ACCOUNT/logs/passenger.log` بدون خطا است.
- [ ] یک ربات تلگرام ساخته، فعال شد، وب‌هوک با `setWebhook` ثبت شد، یک پیام تستی به ربات ارسال شد و در `BotHistory` ظاهر گشت.
- [ ] یک پرداخت کارت‌به‌کارت کامل از یک کاربر آزمایشی ثبت شد، رسید آپلود شد، مدیر آن را approve کرد، و `Order.status=paid` + `WalletTxn` و `LedgerEntry` ایجاد شدند.
- [ ] Backup دیتابیس + فایل‌های `.env` و `storage/` گرفته شد (§۱۳).

اگر هر کدام از این موارد fail شد، استقرار کامل نیست.

---

**پایان سند**.

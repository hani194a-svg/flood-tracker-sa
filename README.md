# رصد السيول — Flood Tracker KSA

منصة لرصد السيول لحظيًا في المملكة العربية السعودية عبر بلاغات المواطنين، مع محرك تحقق تلقائي يعتمد على الموقع الجغرافي للأودية وتقاطع البلاغات وسجل موثوقية المُبلِّغ.

A real-time, crowdsourced flood reporting platform for Saudi Arabia, with an automatic verification engine built on PostGIS.

---

## المكوّنات

| الجزء | التقنية | المجلد |
|---|---|---|
| قاعدة البيانات | PostgreSQL + PostGIS (Supabase) | `db/` |
| الخادم | Node.js + Express + Socket.io | `backend/` |
| خادم البلاطات | Martin (Rust) | `martin/` |
| الواجهة | React + react-map-gl + Mapbox GL JS | `frontend/` |

```
المواطن ──بلاغ──▶ Express API ──▶ PostGIS (fn_process_report)
                       │                 │  قرب الوادي + بلاغات داعمة + ثقة المُبلِّغ
                       │                 ▼
                       │         درجة ثقة 0–100 ── ≥ 80 ⇒ اعتماد تلقائي
                       ▼
                 Socket.io ──▶ لوحة المشرفين (بلاغ جديد / تحديث / تنبيه تجمّع)
                           └─▶ الخريطة العامة (البلاغات المعتمدة فقط)
Martin ◀── PostGIS: valleys + verified_reports ──▶ بلاطات MVT للخريطة
```

## محرك التحقق

كل بلاغ يحصل على **درجة ثقة من 0 إلى 100**، تُحسب داخل قاعدة البيانات (`db/migrations/002_verification.sql`):

| الإشارة | الوزن | كيف تُحسب |
|---|---|---|
| القرب من وادٍ | 40 | `ST_Distance` على نوع geography لأقرب وادٍ (بحث KNN بالفهرس). كامل الدرجة داخل 500 م، وتتناقص خطيًا حتى 2000 م |
| بلاغات داعمة | 35 | عدد **المُبلِّغين المستقلين** (لا يُحتسب المستخدم نفسه) ضمن 1 كم و±60 دقيقة، دون البلاغات المرفوضة. 4 مُبلِّغين = الدرجة كاملة |
| ثقة المُبلِّغ | 25 | `users.trust_score`، والمجهول = 0.3 |

- **اعتماد تلقائي** عند 80 فأكثر. وعند وصول بلاغ جديد يُعاد حساب البلاغات المجاورة المعلّقة لأن عدد البلاغات الداعمة لها تغيّر.
- **درجة الثقة للمستخدم** تُحدَّث بالتنعيم البايزي: `(معتمد + 2) / (معتمد + مرفوض + 4)`. المستخدم الجديد يبدأ من 0.5. **قرارات المشرف اليدوية فقط** تؤثر في الدرجة، أما الاعتماد التلقائي فلا، حتى لا تتكوّن حلقة تغذية ذاتية. وإذا غيّر المشرف قراره يُلغى أثر القرار السابق.
- **تنبيه التجمّعات**: `ST_ClusterDBSCAN` على إسقاط UTM 38N. يُرسل تنبيه عبر Socket.io عند وصول التجمّع إلى 5 مُبلِّغين مستقلين، ويُعاد التنبيه إذا كبر التجمّع.
- **مكافحة الإزعاج**: حد للإرسال لكل IP (5 بلاغات كل 10 دقائق)، ورفض البلاغ المكرر من نفس المستخدم ضمن 200 م و10 دقائق، والتحقق من أن الموقع داخل حدود المملكة.

جميع القيم قابلة للتعديل من جدول `verification_config` دون الحاجة لتعديل الكود.

## التشغيل محليًا

### الخيار 1: Docker Compose

```bash
cp frontend/.env.example frontend/.env   # أضف VITE_MAPBOX_TOKEN
docker compose up --build
docker compose exec api npm run create-admin -- admin@example.com 'StrongPass123'
cd frontend && npm install && npm run dev
```

### الخيار 2: مع Supabase (الإنتاج)

**1) قاعدة البيانات (مرة واحدة):** افتح Supabase ← **SQL Editor**، والصق محتوى الملف [`db/supabase_setup.sql`](db/supabase_setup.sql) كاملًا، ثم اضغط **Run**.
الملف يفعّل PostGIS وينشئ الجداول ومحرك التحقق، **ويقفل الجداول عن واجهة Supabase العامة**: يفعّل RLS ويسحب صلاحيات `anon` و `authenticated`، حتى لا يستطيع من يملك المفتاح العام قراءة كلمات المرور المشفرة. تشغيله أكثر من مرة آمن.

> عند إضافة ترحيل جديد شغّل `npm run migrate`، أو أعد توليد الملف بـ `npm run build:supabase-sql`.

**2) رابط الاتصال:** Supabase ← **Connect** ← **Session pooler** (يعمل عبر IPv4؛ الاتصال المباشر `db.xxx.supabase.co` يعمل عبر IPv6 فقط في كثير من الشبكات):
```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

**3) الخادم:**
```bash
cd backend
cp .env.example .env     # DATABASE_URL = رابط Session pooler ، DATABASE_SSL=true ، JWT_SECRET عشوائي
npm install
npm run migrate          # يتأكد أن كل الترحيلات مطبّقة
npm run create-admin -- admin@example.com 'StrongPass123'
npm run dev
```

**4) الأودية الحقيقية من OpenStreetMap:**
```bash
npm run import:valleys -- --remove-sample --save osm-valleys.json
```
- يجلب كل الأودية في المملكة (`waterway=wadi`، والأنهار والمجاري الموسمية) من Overpass API، ويجرّب خوادم بديلة إذا فشل الخادم الأول.
- يدمج المقاطع التي تحمل نفس الاسم ومتصلة ببعض (فرق أقل من 1 كم) في وادٍ واحد. الأودية المتشابهة في الاسم والمتباعدة تبقى منفصلة.
- إعادة التشغيل **تحدّث الأودية في مكانها**، فلا تنقطع ارتباطات البلاغات بها.
- `--remove-sample` يحذف الأودية التجريبية الثلاثة.
- `--file osm-valleys.json` يعيد الاستيراد من ملف محفوظ دون اتصال بالإنترنت.
- لمنطقة محددة فقط: `--bbox 46.3,24.3,47.1,25.1`
- بعد الاستيراد يُعاد حساب درجة الثقة لبلاغات آخر 7 أيام.

**5) Martin:**
```bash
DATABASE_URL='<رابط Session pooler>?sslmode=require' martin --config martin/config.yaml
```

**6) الواجهة:**
```bash
cd frontend && cp .env.example .env && npm install && npm run dev
```
- `VITE_MAPBOX_TOKEN`: مفتاح **عام** يبدأ بـ `pk.` من https://account.mapbox.com/access-tokens. قيّده بنطاقات موقعك (URL restrictions).
- الخريطة العامة: http://localhost:5173
- لوحة المشرفين: http://localhost:5173/#/admin

> بيانات الأودية © OpenStreetMap contributors (رخصة ODbL)، ونسبة الحقوق هذه تظهر تلقائيًا على الخرائط.

## الواجهة البرمجية (API)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/api/auth/register` | عام | تسجيل مستخدم |
| POST | `/api/auth/login` | عام | تسجيل دخول ← JWT |
| GET | `/api/auth/me` | مستخدم | بيانات الحساب ودرجة الثقة |
| POST | `/api/reports` | عام (JWT اختياري) | إرسال بلاغ ← يُقيَّم فورًا |
| GET | `/api/reports/viewport?bbox=minLng,minLat,maxLng,maxLat` | عام / مشرف | بلاغات الشاشة الحالية (العام يرى المعتمدة فقط، والمشرف يستخدم `&status=pending,verified`) |
| GET | `/api/reports?status=&search=&sort=confidence` | مشرف | قائمة البلاغات |
| GET | `/api/reports/clusters` | مشرف | التجمّعات النشطة |
| PATCH | `/api/reports/:id/status` | مشرف | `{ "status": "verified" \| "rejected" }` |

**أحداث Socket.io**
- غرفة المشرفين (`auth: { token }`): ‏`report:new`، ‏`report:updated`، ‏`cluster:alert`
- الجميع: ‏`report:verified`، ‏`report:removed` (حقول عامة فقط)

**Martin**: ‏`/valleys/{z}/{x}/{y}` و `/verified_reports/{z}/{x}/{y}`

## الاختبارات

```bash
createdb floods_test
cd backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/floods_test JWT_SECRET=x npm run seed
npm test
```

تغطي الاختبارات: استيراد أودية OpenStreetMap (الدمج والتحديث في المكان)، والتسجيل والدخول، والتحقق من المدخلات، وتقييم البلاغ حسب القرب من الوادي، ورفض التكرار، والاعتماد التلقائي، وأحداث Socket.io وتنبيه التجمّع، وتحديث درجة الثقة، وفلترة نطاق الخريطة.

## خارطة الطريق

- [ ] رفع صور مع البلاغ (Supabase Storage)
- [ ] حفظ حالة التنبيهات في Redis عند تشغيل أكثر من نسخة من الخادم
- [ ] دمج بيانات رسمية من المركز الوطني للأرصاد أو وزارة البيئة والمياه والزراعة إن توفرت

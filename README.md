# رصد السيول — Flood Tracker KSA

منصة **للتنبؤ بالسيول** في المملكة العربية السعودية من **الطقس المتوقع وتضاريس الأرض ونوع سطحها**، مع بلاغات المواطنين كإشارة ثانوية تؤكد الحدث وتساعد في معايرة النموذج. المنطقة التجريبية الأولى: **جدة**.

Flood forecasting for Saudi Arabia from weather forecasts, terrain and land cover, with citizen reports as a secondary signal. Pilot region: Jeddah.

---

## كيف يعمل التنبؤ

```
مرة واحدة لكل منطقة (analysis/terrain.py)                  كل 1–3 ساعات (analysis/forecast.py)
───────────────────────────────────────                  ─────────────────────────────────────
Copernicus DEM 30 م ─┐                                   Open-Meteo: أمطار كل ساعة (5 أيام سابقة + 3 قادمة)
ESA WorldCover ──────┤→ اتجاه الجريان، القنوات            │
                     │  وأحواضها، زمن وصول المياه         ▼
                     │  رقم المنحنى (صخر/رمل/عمران)     مطر الحوض خلال نافذة زمن الوصول
                     │  مناطق الغمر (HAND ≤ 3 م)        ← رطوبة التربة من الأيام الخمسة
                     └→ PostGIS (load_db.py)              ← جريان SCS-CN ← الذروة م³/ث
                                                          ← مستوى 1–5 (+1 إن وُجدت مبانٍ في منطقة الغمر)
                                                          → PostGIS + NOTIFY → Socket.io → الخريطة
```

| العامل | المصدر | أثره |
|---|---|---|
| المطر المتوقع والسابق | Open-Meteo (ECMWF/GFS/ICON) | كمية المطر على كامل الحوض، ورطوبة التربة |
| التضاريس | Copernicus GLO-30 | مسارات الأودية، مساحة الحوض، الانحدار، سرعة وصول الماء، الأراضي المنخفضة |
| نوع السطح | ESA WorldCover 2021 | الصخر والإسفلت يجريان، والرمل يمتص (رقم المنحنى) |
| التعرّض | WorldCover (مناطق عمرانية) | رفع درجة الخطر حين تقع مبانٍ في منطقة الغمر |
| بلاغات المواطنين | التطبيق | تأكيد الحدث؛ والتوقع نفسه يرفع ثقة البلاغ المتوافق معه |

**اختبار على أحداث حقيقية** (`forecast.py --scenario`):

| الحدث | النتيجة قرب الأحياء التي غرقت | النتيجة في أحياء لم تغرق |
|---|---|---|
| جدة 25 نوفمبر 2009 (90 ملم / 4 س) | قويزة وأم الخير: **شديد**، ذروة 170–230 م³/ث | الكورنيش والروضة: متوسط، 6–11 م³/ث |
| زخة خفيفة (14 ملم / 3 س) | لا خطر في أي قناة | — |

**حدود النموذج:** نموذج فرز سريع (على غرار Flash Flood Guidance)، وليس محاكاة هيدروليكية. لا يحتسب السدود وقنوات التصريف التي أُنشئت بعد 2011 ولا شبكات تصريف الشوارع. السيناريوهات التاريخية توزّع المطر بالتساوي. وبعض الأحواض (مثل وادي فاطمة) تمتد خارج المنطقة فيُقدَّر خطرها بأقل من الحقيقي. **قبل الاستخدام العام يلزم معايرته بأحداث موثّقة أكثر.**

### تشغيل التنبؤ

```bash
pip install -r analysis/requirements.txt
# 1) نزّل بلاطة الارتفاعات والغطاء الأرضي للمنطقة إلى analysis/data/raw/
#    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N21_00_E039_00_DEM/Copernicus_DSM_COG_10_N21_00_E039_00_DEM.tif → dem_N21E039.tif
#    https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N21E039_Map.tif → wc_N21E039.tif
python analysis/terrain.py                     # ~1 دقيقة لجدة → analysis/data/out/jeddah/
DATABASE_URL=… python analysis/load_db.py      # تحميل القنوات والأحواض ومناطق الغمر
DATABASE_URL=… python analysis/forecast.py     # توقع حي (جدوله كل 1–3 ساعات)
DATABASE_URL=… python analysis/forecast.py --scenario jeddah-2009   # إعادة تشغيل حدث تاريخي
python -m unittest discover -s analysis/tests  # اختبارات معادلات الهيدرولوجيا
```

لتغيير المنطقة عدّل `REGION` في `analysis/config.py`. حد Open-Meteo المجاني نحو 10,000 طلب يوميًا، وكل نقطة مطر تُحتسب طلبًا (168 نقطة لجدة)، فالتشغيل كل ساعتين آمن.

**نسخة تجريبية بدون خادم:** `analysis/export_demo.py` ثم `demo/build.py` يُنتجان صفحة HTML واحدة تشغّل النموذج نفسه في المتصفح (`demo/model.js` منقول سطرًا بسطر من `analysis/hydrology.py`).

## المكوّنات

| الجزء | التقنية | المجلد |
|---|---|---|
| قاعدة البيانات | PostgreSQL + PostGIS (Supabase) | `db/` |
| التحليل والتنبؤ | Python: rasterio + pysheds + numpy | `analysis/` |
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

## التحقق من البلاغات (إشارة ثانوية)

كل بلاغ يحصل على **درجة ثقة من 0 إلى 100**، تُحسب داخل قاعدة البيانات (`db/migrations/002_verification.sql`):

| الإشارة | الوزن | كيف تُحسب |
|---|---|---|
| توقع الخطر في المكان والوقت | 25 | أعلى مستوى خطر لقناة ضمن 1 كم و±3 ساعات من آخر توقع. خارج مناطق التنبؤ يُوزَّع وزنه على البقية |
| القرب من وادٍ | 30 | `ST_Distance` على نوع geography لأقرب وادٍ (بحث KNN بالفهرس). كامل الدرجة داخل 500 م، وتتناقص خطيًا حتى 2000 م |
| بلاغات داعمة | 30 | عدد **المُبلِّغين المستقلين** (لا يُحتسب المستخدم نفسه) ضمن 1 كم و±60 دقيقة، دون البلاغات المرفوضة. 4 مُبلِّغين = الدرجة كاملة |
| ثقة المُبلِّغ | 15 | `users.trust_score`، والمجهول = 0.3 |

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
| GET | `/api/forecast/runs?kind=forecast\|scenario\|archive` | عام | عمليات التنبؤ |
| GET | `/api/forecast/regions/:slug/streams.geojson` | عام | شبكة القنوات (ثابتة، مع ETag) |
| GET | `/api/forecast/runs/:run/levels` | عام | مستوى كل قناة لكل ساعة (`:run` = رقم أو `latest`) |
| GET | `/api/forecast/runs/:run/alerts?minLevel=4` | عام | أخطر القنوات، واحدة لكل مسار تصريف |
| GET | `/api/forecast/runs/:run/zones.geojson` | عام | مناطق الغمر للقنوات الخطرة |
| GET | `/api/forecast/runs/:run/streams/:id` | عام | مطر الحوض والخطر لكل ساعة (للرسم البياني) |
| GET | `/api/reports/clusters` | مشرف | التجمّعات النشطة |
| PATCH | `/api/reports/:id/status` | مشرف | `{ "status": "verified" \| "rejected" }` |

**أحداث Socket.io**
- غرفة المشرفين (`auth: { token }`): ‏`report:new`، ‏`report:updated`، ‏`cluster:alert`
- الجميع: ‏`report:verified`، ‏`report:removed` (حقول عامة فقط)، ‏`forecast:updated`، ‏`forecast:alert` (توقع حي بمستوى 4 أو أعلى)

**Martin**: ‏`/valleys`، ‏`/verified_reports`، ‏`/stream_risk` (القنوات بآخر مستوى خطر)، ‏`/flood_zones`

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

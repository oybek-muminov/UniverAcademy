# Bitta guruh bilan o‘qituvchi kabinetini sinash

O‘qituvchi Ustoz saytida avvaldan mavjud Clerk hisobi orqali kiradi. O‘z fanidan guruh yaratadi. Yangi guruh darhol faol bo‘ladi. O‘qituvchi guruhga kirmagan o‘quvchilar ro‘yxatidan ism va o‘n raqamli UniverAcademy ID bo‘yicha o‘quvchini tanlaydi va **Tanlangan o‘quvchini qo‘shish** tugmasini bosadi. O‘quvchini ID raqamini kiritib qo‘shish yoki Telegram orqali taklif qilish ham mumkin. Savol matni, LaTeX formulasi, xususiy rasm, to‘rtta variant, kalit va ixtiyoriy yechimdan test tuzadi. Test davomiyligini soatda kiritadi. Nashr qilingan testni faol guruhga tayinlashda darhol ochish yoki boshlanish sanasi va soatini belgilash mumkin. O‘quvchi Mini App orqali javoblarini saqlab topshiradi. O‘qituvchi o‘z guruhi natijasini ko‘radi.

## Mahalliy qabul

Repo ildizida Node 24 va PostgreSQL uchun mahalliy jarayon ochish imkoni kerak. Har bir yangi ishchi nusxa uchun lockfayllardan bog‘liqliklarni o‘rnating.

```sh
npm ci
npm ci --prefix runtime/teacher-local-ui
npm ci --prefix tests/backend/validator/tooling
npm ci --prefix tests/account-deletion/tooling
npm ci --prefix tests/teacher-local-pilot/tooling
npm ci --prefix apps/mini-app
npm ci --prefix apps/teacher-web/ustoz-pages
node --test tests/teacher-staging-pilot/*.test.mjs
node tests/teacher-staging-pilot/production-smoke.mjs
node tools/check-staging-node-package.mjs
npm --prefix apps/teacher-web/ustoz-pages run build
npm --prefix apps/teacher-web/ustoz-pages run verify
node tools/generate-teacher-cabinet-validator.mjs --check
node --test tests/teacher-worker-cabinet/*.test.mjs
node tests/teacher-staging-pilot/workerd-acceptance.mjs
```

Native sinov katalog, RLS va rollarni alohida PostgreSQL klasterida yaratadi. Alohida API va bot loginlari ishlaydi. Lokal JOSE imzosi va nazorat qilinadigan Clerk holati orqali Ustoz va Mini Appning odatiy HTTP marshrutlari tekshiriladi. Anonim so‘rov, bekor qilingan vakolat, boshqa guruh yoki boshqa o‘quvchiga tegishli rasm sinovlari bor. Haqiqiy Telegramga xabar jo‘natish o‘rniga uning tasdiq javobi agentdan mustaqil test transportida qaytariladi. Toza Node paketini tekshirish buyrug‘i production bog‘liqliklarini o‘rnatib, ajratilgan Vercel funksiyasida ham kontrakt, KaTeX va PNG/SVG ishlashini tekshiradi. Test o‘chirish, qayta tiklash va boshqa Node jarayonida oldingi javobni ochishni ham bajaradi. Bu klaster tugagach o‘chadi. Belgilangan staging bazasiga ishlaydigan Node jarayoni qayta ishga tushganda ma’lumot PostgreSQLda qoladi.

Brauzerda demo ma’lumoti bilan sinab ko‘rish uchun ildizda `npm run start:teacher-pilot`ni ishga tushirib, `http://127.0.0.1:4178/`ni oching. Bu alohida RAM demosidagi ma’lumot qayta ishga tushirilganda tozalanadi. [Mahalliy demo va test namunalari](teacher-local-pilot.md)

## Mavjud Cloudflare xizmatlarida ishga tushirish

| Xizmat | Vazifasi | Operator sozlamasi |
|---|---|---|
| Ustoz Pages | Ustoz va Admin o‘z domenidan kabinetga kiradi. Pages Worker faqat xodim yo‘llarini xususiy bindingga yo‘naltiradi. | Yig‘ilgan `ustoz-pages` paketini tanlang. `UA_CABINET_API` service bindingini `univeracademy-api` Worker’ining `TeacherCabinetGateway` nomli kirishiga ulang. `UA_CABINET_TEACHER_ORIGIN=https://ustoz.univeracademy.uz`. |
| API Worker | Xodim so‘rovini xususiy bindingda, o‘quvchi so‘rovini ochiq `/api/v1/student/pilot/*` marshrutida qabul qiladi. | `CABINET_HYPERDRIVE` xizmat logini uchun kabinet rolini tanlang. Alohida `TEACHER_PILOT_HYPERDRIVE` bot yetkazish loginidan foydalanadi. Ikkalasida ham so‘rov keshini o‘chiring, baza bilan TLSni tekshiring. `UA_CABINET_TEACHER_ORIGIN` va `UA_CABINET_STUDENT_ORIGIN=https://mini.univeracademy.uz` belgilang. |
| Clerk | O‘qituvchini joriy sessiya va Supabase’da tasdiqlangan rol/fan orqali taniydi. | API Worker avvaldan mavjud `UA_CLERK_PROVIDER_SETTINGS` va `UA_CLERK_SECRET_KEY`ni ishlatadi. Ustoz originini faqat kabinet verifikatoriga qo‘shadi. Pages brauzerida tegishli Clerk public kaliti bo‘ladi. |
| Mini App va Telegram | O‘quvchi o‘z sessiyasi bilan taklifni qabul qiladi va testni bajaradi. Bot navbatdan shaxsiy taklif yuboradi. | Mavjud Mini App originini va API manzilini ishlating. Botdagi `TELEGRAM_PILOT_DIRECTORY` faqat tegishli API entrypointga bog‘lanadi. Jadvaldagi har chaqiruv bir taklifni yuboradi. |

1. Uni yoqishdan oldin API Worker va Bot konfiguratsiyalaridagi resurslar jonli ro‘yxatga mosligini tekshiring. `keep_vars` o‘zgaruvchilarni saqlaydi. Hyperdrive, service binding va Cron jadvali operator konfiguratsiyasida alohida yuritiladi. Birinchi nashrda `UA_CABINET_STAGING_ENABLED`, Ustoz va Mini App build bayroqlari, bot yozuvi va yetkazish bayroqlari o‘chiq bo‘ladi. Shu holatda oddiy Telegram/Clerk kirishi, profil va testlar ro‘yxatini tekshiring.
2. Quyidagi boshqariladigan Supabase migratsiyasi, alohida xizmat loginlari va kabinet doirasidagi vakolatlarni tayyorlang. API Worker va Pages’da `UA_CABINET_RUNTIME=worker`ni tanlang. API Worker, keyin Pages uchun `UA_CABINET_STAGING_ENABLED=true` qiling. Ustoz/Adminga faqat o‘z domenidagi sahifadan kirish ochiladi.
3. Ustoz uchun `VITE_USTOZ_CABINET_WRITE_ENABLED=true` va mavjud Clerk kirish sozlamalari, Mini uchun `VITE_TEACHER_PILOT_ENABLED=true` bilan tegishli frontendlarni qayta yig‘ing. Bot qaydi va yuboruvchini pastdagi Telegram yo‘riqnomasi orqali yoqing. Bir taklif bilan tasdiqlovchi xabarni, o‘quvchining testni tugatishini va o‘qituvchi kabinetidagi ballni tekshiring.
4. Jonli pilotda rasm hajmini asta kattalashtirib, haqiqiy savolda Worker CPU va xotirasini kuzating. Ish stolidagi vaqt Cloudflare tomonidan hisoblangan CPU vaqtini o‘lchamaydi. 2026-yil noyabrda Workers Free chegarasi so‘rov uchun 10 ms CPU. Mahalliy qizdirilgan workerd jarayonida 512 px PNG uchun taxminan 23 ms, 40 elementli SVG uchun 101 ms CPU kuzatildi. Bu Cloudflare hisoblagan CPU vaqti emas. Birinchi jonli tekshiruvda matnli savol va kichik rasm uchun Worker CPU/error metrikalarini ko‘ring. CPU limiti oshsa keng foydalanishni to‘xtatib, rasmni tayyorlash yo‘lini qayta baholang. [Cloudflare Workers limitlari](https://developers.cloudflare.com/workers/platform/limits/)

Oldingi xususiy Node proksisini ishlatadigan muhitda `UA_CABINET_RUNTIME=node` yoki belgilanmagan qiymat avvalgi yo‘lni tanlaydi. U yerda Pages va API proksisiga `UA_CABINET_STAGING_NODE_ORIGIN` va kamida 32 belgili `UA_CABINET_STAGING_PROXY_SECRET` kerak. Node uchun `UA_CABINET_STAGING_DATABASE_URL` (`sslmode=verify-full`), `UA_CABINET_CLERK_SETTINGS` va `UA_CABINET_CLERK_SECRET` ishlatiladi. Worker rejimi xususiy service bindingdan foydalanadi.

[Ustoz Pages yig‘ish va marshrutni tekshirish](../apps/mini-app/teacher-entrance/README.md) · [Bot, alohida service binding va navbat](staging-bot-invites.md)

## Staging bazasi va Ega tayinlaydigan vakolatlar

1. Baza egasi tanlagan klasterda tiklash nuqtasini va katalogni tekshiring. Eski fizik ID ustuni bilan ko‘rinish hali yaratilmagan bo‘lsa, avval expand bosqichi bajariladi. Ko‘rinish bor-u fizik ustun eski bo‘lsa, yangilangan backendga o‘tish, forward va profil backfill tartibini bajaring. Fizik ustun allaqachon `univeracademy_id` nomida bo‘lsa, `ua_private.people_registration` mavjudligini, profil CHECK tasdiqlanganini va eski JSON kaliti qolmaganini tekshiring. Har bosqichda ichki shaxs va o‘n raqamli ID bog‘lanishi, jumladan boshidagi nollar saqlanishi kerak. [ID migratsiyasi tartibi](../supabase/migrations/cabinet-id/README.md)
2. Supabase boshqaradigan PostgreSQL 17 uchun `node supabase/migrations/teacher-staging/managed.mjs up > /tmp/ua_managed_cabinet_up.sql` orqali SQL tayyorlang. Tekshirilgan faylni tasdiqlangan bazada bitta tranzaksiyada bajaring. U kabinet obyektlarini o‘z egasi nomidan yaratadi va operator huquqlarini yakunda tekshiradi. Shundan so‘ng alohida API loginiga `ua_api_login WITH INHERIT TRUE, SET FALSE` va `ua_cabinet_stage WITH INHERIT FALSE, SET TRUE`, alohida bot loginiga `ua_cabinet_delivery WITH INHERIT FALSE, SET TRUE` a’zoliklarini bering. Parollar server sirlar omborida saqlanadi. [Baza, xizmat rollari va qaytarish tartibi](../supabase/migrations/teacher-staging/README.md)
3. O‘qituvchi uchun Ega mavjud shaxs UUIDsi, Clerk instansiyasi issuer URLi, foydalanuvchining tekshirilgan `user_…` subjecti va fan katalogidagi haqiqiy `subject_id`ni tanlaydi. Mavjud odamning `ua_private.people.enabled=true` va `roles` ro‘yxatida `teacher` bo‘lsin. `clerk_identities(issuer,subject,person_id,enabled=true)` aynan shu shaxsga tegishli bo‘lsin. Eski staff kirishi ham ishlatilsa, uning `staff_identities(issuer,provider_subject,person_id)` mappingini shu odam bilan moslang. Email o‘xshashligi shaxsni bog‘lashga asos bermaydi.
4. `staff_access(person_id,approved=true)`, `teacher_subject_approvals(person_id,subject_id,approved=true,revoked_at_ms=NULL)` hamda topshiriq uchun `staff_subject_scope(person_id,subject_id,revoked_at_ms=NULL)` tegishli shaxsga beriladi. Boshqa mavjud rollar va vakolatlar saqlanadi. O‘qituvchi uchun `all_groups`, `all_subjects` yoki Admin vakolatini berish shart emas. Staff vakolatlarini Ega Supabase orqali tayinlaydi.
5. O‘qituvchi guruh yaratganda guruh va aynan shu guruhni boshqarish vakolati birga yoziladi. O‘qituvchi kabinetini ochganda, o‘zining ruxsat berilgan fanlaridagi avvalgi kutilayotgan guruhlari ham mavjud ID raqami bilan faollashadi. Admin o‘ziga avval berilgan vakolat doirasidagi guruhlarni **Admin bo‘limi**da ko‘ra oladi.

Baza egasi quyidagi o‘qish so‘rovini o‘zi tanlagan muhitda, psql o‘zgaruvchilariga uchta tasdiqlangan qiymatni berib bajarishi mumkin. Kutilgan natija bitta qator, faol rol va aynan berilgan fan. `can_assign_subject` ham `true` bo‘ladi. Ustoz kabinetiga mavjud Clerk hisobi bilan kiring va o‘z faningizdan guruh yarating. Yangi guruh tanlanganini, o‘quvchini ID orqali qo‘shish va Telegram taklifini yuborish mumkinligini tekshiring. Guruhga o‘quvchi qo‘shilgach, shu fan bo‘yicha nashr qilingan testni biriktiring.

```sql
SELECT p.id, p.enabled, p.roles, s.approved, t.subject_id,
       s.all_subjects OR EXISTS (
         SELECT 1 FROM ua_private.staff_subject_scope sc
         WHERE sc.person_id=p.id AND sc.subject_id=t.subject_id
           AND sc.revoked_at_ms IS NULL
       ) AS can_assign_subject
FROM ua_private.people p
JOIN ua_private.clerk_identities c ON c.person_id=p.id AND c.enabled
JOIN ua_private.staff_access s ON s.person_id=p.id AND s.approved
JOIN ua_private.teacher_subject_approvals t ON t.person_id=p.id
WHERE p.enabled AND 'teacher'=ANY(p.roles)
  AND c.issuer=:'issuer' AND c.subject=:'clerk_user'
  AND t.approved AND t.revoked_at_ms IS NULL AND t.subject_id=:'subject_id';
```

[ID migratsiyasi](../supabase/migrations/cabinet-id/README.md) · [Staging vakolatlari va ma’lumotni saqlab ortga qaytarish](../supabase/migrations/teacher-staging/README.md)

O‘qituvchiga rol berilgach, botdagi «Kabinet» tugmasi uni Ustoz sahifasiga olib boradi. Faqat o‘quvchi roli bor hisobga o‘quvchi kabineti ochiladi. Bot o‘qituvchiga bir marta tugmasiz xabar yuboradi va 24 soat o‘tgach uni o‘chiradi. Buni mavjud API Worker jadvali bajaradi (`UA_TEACHER_NOTICES_ENABLED=true`). Yangilanishni qaytarishda navbatdagi xabarlarni tozalab, avval [xabar migratsiyasini qaytarish tartibini](../supabase/migrations/teacher-notifications/README.md) bajaring.

## Pilotning amaliy chegaralari

- Tayinlash vaqti Toshkent bo‘yicha belgilanadi. O‘quvchi test ochilguncha boshlanish sanasi va soatini ko‘radi. Yangi urinishni o‘sha kun yakunigacha boshlash mumkin. Boshlangan urinish uchun vaqt o‘quvchi testni ochgan paytdan hisoblanadi.
- O‘quvchi ID satrida o‘nta raqam saqlanadi. Guruh almashishi alohida Admin amalidir. Tayinlash paytidagi ro‘yxat topshiriqqa bog‘lanadi. Shu topshiriqqa kirishi kerak bo‘lgan o‘quvchilarni avval guruhga qo‘shing.
- O‘qituvchi LaTeX kodini yozadi; Teacher va Student bir xil KaTeX versiyasidan foydalanadi. Xato formulada server savol, blok va imkon bo‘lsa belgi o‘rnini ko‘rsatadi. Faol urinish faqat savol va variantlarni beradi.
- Har rasm uchun PNG 2 MiB, statik SVG 256 KiB, tomonlari 2048 pikselgacha. Fayl tasdiqlangach qayta kodlangan PNG 8 MiB gacha yopiq PostgreSQL `bytea`da saqlanadi. Server o‘qituvchi egaligini yoki o‘quvchining joriy topshirig‘i, a’zolik davri va ochiq urinishini har o‘qishda tekshiradi. Test JSON so‘rovi 512 KiB gacha. Katta media keyin Backblaze B2 xususiy bucketiga ko‘chirilishi mumkin. Bunda kabinetdagi asset ID va har so‘rov uchun ruxsat tekshiruvi saqlanadi. Mavjud baytlar checksum orqali ko‘chirilib, zaxiradan tiklash sinovdan o‘tkaziladi. Bitta guruh pilotida rasmlar PostgreSQLda turadi.
- Shaxsiy taklif 24 soat amal qiladi. Bevosita yuborish uchun o‘quvchi tizimga Telegramini bog‘lagan va bot bilan private chat boshlagan bo‘lishi kerak. `queued` faqat navbatga yozilganini bildiradi. Aloqa yuborish vaqtida uzilsa, `unconfirmed` yoki eski `claimed` holatini operator tekshiradi; noaniq jo‘natish avtomatik takrorlanmaydi. Umumiy havolani o‘qituvchi alohida ulasha oladi.
- Jonli qabul uchun avval ruxsatli staging originlar, Clerk mapping, xizmat loginlari va bot bog‘lanishlarini tayyorlang. Rozilik bildirgan o‘qituvchi va o‘quvchi bilan bitta guruhda boshidan oxirigacha oddiy kirish, test topshirish, qayta kirish, xabar holati hamda natijani tekshiring. Yashirin kalit/yechim, ochilmagan taklif va boshqa guruh natijasini alohida tekshiring. Yuklama sinovi va o‘lchangan sig‘im keyingi bosqich.
- Qaytarish uchun avval frontend bayroqlari, ikkala edge, Node va dispatchni o‘chirib, faol tranzaksiyalar tugashini kuting. So‘ng o‘rnatish usuliga mos qaytarish SQLini qo‘llang. Boshqariladigan Supabase operatori uchun `managed.mjs down`, qayta yoqish uchun `managed.mjs restore` SQL chiqaradi. Birlamchi test/urinish/ball jadvallari saqlanadi. Qo‘shimcha yopiq ma’lumot `ua_cabinet_retained`ga o‘tadi; `up.sql` qayta faollashtiradi. Native qabul ayni guruh, xususiy PNG va ballning shu sikldan keyin o‘qilishini tekshiradi.

## Guruhga qo‘shish mumkin bo‘lgan o‘quvchilar

O‘qituvchi o‘zining faol guruhida ro‘yxatni ochganda kabinet `GET /api/v1/teacher/pilot/groups/{groupId}/available-students` orqali 25 tagacha o‘quvchini UniverAcademy ID tartibida oladi. Javobda `data.students` ichida har o‘quvchining `name` va o‘n raqamli `univeracademy_id` maydonlari keladi. `data.nextCursor` bo‘lsa, keyingi sahifa shu qiymatni `?after=0000000017` shaklida yuboradi. Oxirgi sahifada `nextCursor` qiymati `null` bo‘ladi.

Ro‘yxatga ro‘yxatdan o‘tishni tugatgan, hisobi faol, yagona roli o‘quvchi bo‘lgan shaxslar kiradi. Profil va a’zolik yozuvida guruh bog‘lanishi bo‘sh bo‘lishi kerak. Tanlangan ID mavjud `addMember` amaliga beriladi. Orada boshqa guruh o‘quvchini qo‘shgan yoki a’zolikni hozir o‘zgartirayotgan bo‘lsa, API `409` qaytaradi. Ro‘yxat qayta yuklanganda o‘quvchining joriy holati ko‘rinadi.

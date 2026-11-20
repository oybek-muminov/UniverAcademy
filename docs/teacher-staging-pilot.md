# Bitta guruh bilan o‘qituvchi kabinetini sinash

O‘qituvchi Ustoz saytida avvaldan mavjud Clerk hisobi orqali kiradi. O‘z faniga guruh so‘raydi, Admin tasdiqlaydi. O‘qituvchi ro‘yxatdan o‘tgan o‘quvchini o‘n raqamli UniverAcademy ID bilan qo‘shadi yoki Telegramdan taklif qiladi. Savol matni, LaTeX formulasi, xususiy rasm, to‘rtta variant, kalit va ixtiyoriy yechimdan test tuzadi. Testni nashr qiladi va faol guruhga tayinlaydi. O‘quvchi Mini App orqali javoblarini saqlab topshiradi. O‘qituvchi o‘z guruhi natijasini ko‘radi.

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
```

Native sinov katalog, RLS va rollarni alohida PostgreSQL klasterida yaratadi. Alohida API va bot loginlari ishlaydi. Lokal JOSE imzosi va nazorat qilinadigan Clerk holati orqali Ustoz va Mini Appning odatiy HTTP marshrutlari tekshiriladi. Anonim so‘rov, bekor qilingan vakolat, boshqa guruh yoki boshqa o‘quvchiga tegishli rasm sinovlari bor. Haqiqiy Telegramga xabar jo‘natish o‘rniga uning tasdiq javobi agentdan mustaqil test transportida qaytariladi. Toza Node paketini tekshirish buyrug‘i production bog‘liqliklarini o‘rnatib, ajratilgan Vercel funksiyasida ham kontrakt, KaTeX va PNG/SVG ishlashini tekshiradi. Test o‘chirish, qayta tiklash va boshqa Node jarayonida oldingi javobni ochishni ham bajaradi. Bu klaster tugagach o‘chadi. Belgilangan staging bazasiga ishlaydigan Node jarayoni qayta ishga tushganda ma’lumot PostgreSQLda qoladi.

Brauzerda demo ma’lumoti bilan sinab ko‘rish uchun ildizda `npm run start:teacher-pilot`ni ishga tushirib, `http://127.0.0.1:4178/`ni oching. Bu alohida RAM demosidagi ma’lumot qayta ishga tushirilganda tozalanadi. [Mahalliy demo va test namunalari](teacher-local-pilot.md)

## Ulanish yo‘li

| Kirish | Ilova yo‘li va majburiy sozlama |
|---|---|
| Ustoz va Admin | Mavjud `univeracademy-ustoz` Pages loyihasi uchun yig‘ilgan Ustoz frontend va Pages Worker. Brauzer shu originning `/api/v1/teacher/pilot/*` va `/api/v1/admin/pilot/*` yo‘llariga yuboradi. Buildda `VITE_USTOZ_CABINET_WRITE_ENABLED=true`, Clerk kirish roziligi va mos public kalit kerak. |
| O‘quvchi | Mavjud Mini App kirish yo‘li; `VITE_TEACHER_PILOT_ENABLED=true`, tasdiqlangan `VITE_API_ORIGIN`. Uning amaldagi opaque sessiyasi bilan API Worker `/api/v1/student/pilot/*` yo‘liga boradi. CORS aynan Mini App originini qabul qiladi. |
| Node | Repo ildizidagi `vercel.json` va `api/index.mjs` yagona Web Request kirish nuqtasini beradi. Operator shu kod uchun Node 24 ishlatadigan loyihani, uning aniq HTTPS originini va cheklangan PG ulanishini tanlaydi. Ustoz Pages va API Worker faqat ushbu originga yuboradi. Ajratilgan Node manzili, to‘lovi va ajratilgan xizmat logini operator tomonidan hali tasdiqlanishi kerak. |
| Telegram | Bot webhooki private startni tekshiradi. Ajratilgan service binding uning tasdig‘ini bazaga yozadi. Alohida dispatch jarayoni har ishga tushganda navbatdan bitta xabarni oladi. |

Ustoz va API edge uchun `UA_CABINET_STAGING_ENABLED=true`, bir xil `UA_CABINET_STAGING_NODE_ORIGIN`, 32 yoki ko‘proq belgili `UA_CABINET_STAGING_PROXY_SECRET` hamda tegishli `UA_CABINET_TEACHER_ORIGIN` yoki `UA_API_ORIGIN`ni belgilang. Node uchun shu qiymatlarga `UA_CABINET_STUDENT_ORIGIN`, `UA_CABINET_STAGING_DATABASE_URL` va Clerk verifier qiymatlari qo‘shiladi. Tashqi PostgreSQL ulanishi uchun `sslmode=verify-full` va ishonchli CA kerak. Bir Node jarayonida ko‘pi bilan to‘rt ulanish ochiladi. Alohida jarayonlar soni bilan birga umumiy ulanish limitini tekshiring.

`UA_CABINET_CLERK_SETTINGS` JSON obyekti: `issuer`, `authorizedParties` (Ustoz origini bilan), `audience` (amaldagi Clerk siyosati), `jwksCacheMs`, `jwksCooldownMs`, `timeoutMs`, `maxJwksBytes`. Xuddi shu Clerk instansiyasi uchun `UA_CABINET_CLERK_SECRET` faqat Node sirlarida turadi. `UA_CABINET_ALLOW_LEGACY_TELEGRAM=true` faqat eski, amaldagi Telegram orqali tasdiqlangan student sessiyalarini alohida qabul qilishga ruxsat berilganda qo‘yiladi. Brauzerga faqat odatiy ochiq origin va Clerk publishable key beriladi.

[Ustoz Pages yig‘ish va marshrutni tekshirish](../apps/mini-app/teacher-entrance/README.md) · [Bot, alohida service binding va navbat](staging-bot-invites.md)

## Staging bazasi va Ega tayinlaydigan vakolatlar

1. Baza egasi tasdiqlagan staging klasterida katalog, kengaytma va tiklash nuqtasini tekshiring. Hozirgi jonli katalogda eski ID ustuni bor. `node supabase/migrations/cabinet-id/migrate.mjs expand` mavjud qiymat va boshidagi nollarni saqlab, `ua_private.people_registration` ko‘rinishini yaratadi. Pilotga ushbu bosqich yetadi.
2. `psql -v ON_ERROR_STOP=1 -f supabase/migrations/teacher-staging/up.sql`ni aynan tanlangan bazada bajaring. Jarayon `ua_cabinet_stage` va `ua_cabinet_delivery` xizmat rollarini yaratadi. PG17 da alohida server loginlari `NOINHERIT NOSUPERUSER NOBYPASSRLS` bo‘lsin. API loginiga mavjud `ua_api_login WITH INHERIT TRUE, SET FALSE` va `ua_cabinet_stage WITH INHERIT FALSE, SET TRUE`; alohida bot loginiga `ua_cabinet_delivery WITH INHERIT FALSE, SET TRUE` a’zoliklari kerak. `GRANT <role> TO <operator tanlagan login> WITH ...`ni DB egasi bajaradi. Haqiqiy login parollari operatorning sirlar omborida turadi.
3. O‘qituvchi uchun Ega mavjud shaxs UUIDsi, Clerk instansiyasi issuer URLi, foydalanuvchining tekshirilgan `user_…` subjecti va fan katalogidagi haqiqiy `subject_id`ni tanlaydi. Mavjud odamning `ua_private.people.enabled=true` va `roles` ro‘yxatida `teacher` bo‘lsin. `clerk_identities(issuer,subject,person_id,enabled=true)` aynan shu shaxsga tegishli bo‘lsin. Eski staff kirishi ham ishlatilsa, uning `staff_identities(issuer,provider_subject,person_id)` mappingini shu odam bilan moslang. Email o‘xshashligi shaxsni bog‘lashga asos bermaydi.
4. `staff_access(person_id,approved=true)`, `teacher_subject_approvals(person_id,subject_id,approved=true,revoked_at_ms=NULL)` hamda topshiriq uchun `staff_subject_scope(person_id,subject_id,revoked_at_ms=NULL)` tegishli shaxsga beriladi. Boshqa mavjud rollar va vakolatlar saqlanadi. O‘qituvchi uchun `all_groups`, `all_subjects` yoki Admin vakolatini berish shart emas. Staff vakolatlarini Ega Supabase orqali tayinlaydi.
5. Alohida tasdiqlovchi uchun shu Clerk mapping, faol `people.roles` ichida `admin`, `staff_access.approved=true`, `manage_roster=true` va so‘ralgan fanga `staff_subject_scope` yoki mavjud `all_groups=true` vakolati kerak. Admin Ustoz sahifasidagi **Admin bo‘limi**dan so‘rovni tasdiqlaganda guruh va aniq o‘qituvchi guruh doirasi birga yoziladi.

Baza egasi quyidagi o‘qish so‘rovini o‘zi tanlagan muhitda, psql o‘zgaruvchilariga uchta tasdiqlangan qiymatni berib bajarishi mumkin. Kutilgan natija bitta qator, faol rol va aynan berilgan fan. `can_assign_subject` ham `true` bo‘ladi. Keyingi tekshiruv mavjud Clerk hisobi bilan Ustoz kabinetiga kirish, o‘z fanini ko‘rish, guruh so‘rovini yuborish hamda alohida Admin orqali tasdiqlashdir.

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

## Pilotning amaliy chegaralari

- O‘quvchi ID satrida o‘nta raqam saqlanadi. Guruh almashishi alohida Admin amalidir. Tayinlash paytidagi ro‘yxat topshiriqqa bog‘lanadi. Shu topshiriqqa kirishi kerak bo‘lgan o‘quvchilarni avval guruhga qo‘shing.
- O‘qituvchi LaTeX kodini yozadi; Teacher va Student bir xil KaTeX versiyasidan foydalanadi. Xato formulada server savol, blok va imkon bo‘lsa belgi o‘rnini ko‘rsatadi. Faol urinish faqat savol va variantlarni beradi.
- Har rasm uchun PNG 2 MiB, statik SVG 256 KiB, tomonlari 2048 pikselgacha. Fayl tasdiqlangach qayta kodlangan PNG 8 MiB gacha yopiq PostgreSQL `bytea`da saqlanadi. Server o‘qituvchi egaligini yoki o‘quvchining joriy topshirig‘i, a’zolik davri va ochiq urinishini har o‘qishda tekshiradi. Test JSON so‘rovi 512 KiB gacha. Katta media uchun private obyekt omboriga o‘tishda ayni asset ID va avtorizatsiyani saqlash, mavjud baytlarni tekshirib ko‘chirish hamda zaxira/tiklashni sinash talab qilinadi.
- Shaxsiy taklif 24 soat amal qiladi. Bevosita yuborish uchun o‘quvchi tizimga Telegramini bog‘lagan va bot bilan private chat boshlagan bo‘lishi kerak. `queued` faqat navbatga yozilganini bildiradi. Aloqa yuborish vaqtida uzilsa, `unconfirmed` yoki eski `claimed` holatini operator tekshiradi; noaniq jo‘natish avtomatik takrorlanmaydi. Umumiy havolani o‘qituvchi alohida ulasha oladi.
- Jonli qabul uchun avval ruxsatli staging originlar, Clerk mapping, xizmat loginlari va bot bog‘lanishlarini tayyorlang. Bitta rozilik bildirgan o‘qituvchi, tasdiqlovchi Admin va bitta guruh bilan boshidan oxirigacha oddiy kirish, test topshirish, qayta kirish, xabar holati hamda natijani tekshiring. Yashirin kalit/yechim, ochilmagan taklif va boshqa guruh natijasini alohida tekshiring. Yuklama sinovi va o‘lchangan sig‘im keyingi bosqich.
- Qaytarish uchun avval frontend bayroqlari, ikkala edge, Node va dispatchni o‘chirib, faol tranzaksiyalar tugashini kuting. So‘ng `down.sql`ni qo‘llang. Birlamchi test/urinish/ball jadvallari saqlanadi. Qo‘shimcha yopiq ma’lumot `ua_cabinet_retained`ga o‘tadi; `up.sql` qayta faollashtiradi. Native qabul ayni guruh, xususiy PNG va ballning shu sikldan keyin o‘qilishini tekshiradi.

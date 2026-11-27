# Yangi o'quvchi faqat Telegram orqali (tezkor ro'yxatdan o'tish)

Vazifa: `docs/vazifa-yangi-oquvchi-telegram.md` (2026-11-27). Hammasi dastlab **o'chiq**; uchta bayroq bilan yoqiladi.

## O'quvchi nimani ko'radi
1. Botda `/start` → bitta tugma: **«Kabinetni ochish»** (Telegram ichida ochiladi).
2. «Ism va familiyangiz» oynasi: ikkala maydon Telegram'dagi ismdan oldindan to'ldirilgan, pastda «Davom etish».
3. «Kabinet tayyorlanmoqda…» → kabinet ochiladi. Ism ikkinchi marta so'ralmaydi. Guruh taklifi (`?invite=`) bo'lsa, kabinetda avvalgidek chiqadi.
4. Keyingi kirishlarda kabinet darhol ochiladi (mavjud `/api/v1/auth/telegram/resume`).
Xato bo'lsa: qisqa o'zbekcha xabar va «Qayta urinish». Clerk yoki Google oynasi hech qachon chiqmaydi.

## Ichkarida nima bo'ladi
| Qadam | Kim | Nima |
|---|---|---|
| 1 | Mini App | `POST /api/v1/auth/telegram/register` `{init_data, first_name, last_name}` |
| 2 | API | `init_data` imzosi va muddati tekshiriladi (iste'mol qilinmaydi); ism tekshiriladi; Telegram allaqachon kabinetga bog'langan bo'lsa → `already_registered` |
| 3 | API | Clerk'da `external_id = tg:<id>` qidiriladi; yo'q bo'lsa email/parolsiz yaratiladi. Clerk `external_id` ni takrorlashga yo'l qo'ymaydi, shuning uchun ikki marta bosish ikkinchi hisob yaratmaydi |
| 4 | API | Clerk hisobi boshqa kabinetga bog'langan bo'lsa → `IDENTITY_LINK_CONFLICT`. Aks holda 180 soniyalik bir martalik kirish tokeni qaytadi (faqat token) |
| 5 | Mini App | `signIn.create({strategy:'ticket'})` + `setActive` (ko'rinmaydi) |
| 6 | Mini App | Mavjud atomik kirish: `POST /api/v1/auth/telegram/entry` (`confirmation: link-telegram-account-v1`) — kabinet + Telegram bog'lash + sessiya bitta tranzaksiyada |
| 7 | Mini App | Kabinet profili hali to'ldirilmagan bo'lsa, o'sha ism bilan mavjud `PATCH /me` chaqiriladi |

Cheklov: bitta Telegram hisobiga 10 daqiqada 5 ta so'rov (har server nusxasi bo'yicha; asosiy himoya — Telegram imzosi).
Kontrakt: `contracts/telegram-register.review.openapi.json` (alohida fayl; asosiy `telegram-return.openapi.json` o'zgartirilmadi, chunki uning izi Mini App yig'ilishi sozlamalari va 15 ta joyda qotirilgan).
Maxfiy kalit: yangi kalit **kerak emas** — API Worker'dagi mavjud `UA_CLERK_SECRET_KEY` ishlatiladi. Migratsiya **kerak emas**.

## Muhim: atomik kirish bayrog'i bilan farq
`UA_TELEGRAM_ATOMIC_ENTRY_ENABLED=true` qilinsa eski `/auth/telegram/link` yopiladi va `/auth/clerk` Mini App tokenlarini rad etadi — bu brauzerdagi Google yo'lini buzadi. Shuning uchun uni **yoqmang**. Yangi `UA_TELEGRAM_REGISTER_ENABLED=true` faqat `/auth/telegram/entry` eshigini ochadi, boshqa yo'llarga tegmaydi.

## Yoqish tartibi (shu ketma-ketlikda)
0. Loyiha egasi Clerk production'da email majburiyligini o'chiradi (`auth_email.required_for_sign_up = false`; telefon yoki username ham majburiy bo'lmasligi kerak). Shusiz 3-qadam 503 beradi, lekin hech narsa buzilmaydi.
1. Kodni push qilish (alohida ruxsat bilan). Hamma bayroq o'chiq — hech narsa o'zgarmaydi.
2. **`univeracademy-api`** Worker (oddiy o'zgaruvchilar):
   - `UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES` = `["https://mini.univeracademy.uz"]`
   - `UA_TELEGRAM_REGISTER_ENABLED` = `true`
   - (`UA_TELEGRAM_ATOMIC_ENTRY_ENABLED` ni **qo'ymang**.)
   - Eslatma: API Worker push bilan avtomatik yangilanmasligi mumkin — jonli versiyada yangi kod borligini paneldan tekshiring.
3. **`univeracademy-mini`** qurilish o'zgaruvchisi: `VITE_TELEGRAM_QUICK_REGISTER` = `true` → qayta qurish. (Hozirgi o'quvchilar uchun hech narsa o'zgarmaydi: ular `resume` orqali kiradi.)
4. Bitta sinov Telegram hisobi bilan: Mini App'ni menyudan yoki havola orqali ochib, to'liq oqimni tekshiring (ism → kabinet → `/start` qayta → darhol kabinet).
5. **`univeracademy-bot`**: `TELEGRAM_QUICK_REGISTER` = `true`. Shundan keyin yangi o'quvchilar «Kabinetni ochish» tugmasini oladi. (Jonli yo'l `TELEGRAM_MESSAGE_LIFECYCLE_ENABLED=true` orqali — ikkalasi ham qo'llab-quvvatlanadi.)

## O'chirish (orqaga qaytish)
- Tez: botdan `TELEGRAM_QUICK_REGISTER` ni olib tashlang (yoki `false`) — eski tugma darhol qaytadi.
- To'liq: `univeracademy-mini` da `VITE_TELEGRAM_QUICK_REGISTER` ni olib tashlab qayta quring; `univeracademy-api` da `UA_TELEGRAM_REGISTER_ENABLED=false`.
- Yaratilgan Clerk hisoblari va kabinetlar o'z joyida qoladi; ular `resume` orqali avvalgidek ishlaydi.
- Eski brauzer yo'li (`/telegram-link`, `MINI_BROWSER_LINK_URL`) kodda turibdi, faqat yangi o'quvchilarga taklif qilinmaydi.

## Ochiq savollar / jonli tekshiruv kerak
- Bir martalik token bilan kirgan Clerk sessiyasida «yaqinda tasdiqlangan» belgisi (`fva`) bo'lishi kerak: Clerk `ticket` ni birinchi omil deb hisoblaydi. Lokal testlar buni tasdiqlay olmaydi — 4-qadamda tekshiriladi. Bo'lmasa, atomik kirish `REVERIFICATION_REQUIRED` beradi, o'quvchi «Qayta urinish»ni ko'radi; tekshiruv yumshatilmagan.
- `initData` 300 soniya (5 daqiqa) amal qiladi. Ism oldindan to'ldirilgani uchun odatda yetadi; o'tib ketsa, «Vaqt tugadi. Kabinetni botdan /start orqali qayta oching» chiqadi.
- Clerk'da «yangi qurilma tasdig'i» (client trust) yoqilgan bo'lsa, `ticket` kirishiga ta'sir qilmasligi 4-qadamda tekshirilsin.

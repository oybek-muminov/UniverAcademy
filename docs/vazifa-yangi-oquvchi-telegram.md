# Vazifa: yangi o‘quvchi faqat Telegram orqali ro‘yxatdan o‘tsin

Loyiha egasining qarori (2026-11-27). Bu hujjatni oxirigacha o‘qib, keyin ishla.

## Maqsad

Yangi o‘quvchi uchun butun jarayon Telegram ichida, 2 ta bosish va taxminan 10 soniyada tugashi kerak:

1. O‘quvchi botda `/start` bosadi. Bot bitta tugma yuboradi: **«Kabinetni ochish»** (`web_app`, `MINI_CABINET_URL`).
2. Mini App ochiladi. O‘quvchi yangi bo‘lsa, bitta oyna chiqadi: **Ism** va **Familiya** maydonlari Telegram ma'lumotidan oldindan to‘ldirilgan (`initDataUnsafe.user.first_name/last_name`), pastda **«Davom etish»** tugmasi turadi.
3. «Davom etish» bosiladi va kabinet ochiladi. Bu bosqichda Clerk oynasi, Google, email kodi, brauzerga chiqish yoki Telegram'ni qayta tasdiqlash bo‘lmaydi.
4. Keyingi kirishlarda ism so‘ralmaydi, kabinet darhol ochiladi. Bu qism hozir ham ishlaydi (`/api/v1/auth/telegram/resume`).

Google bilan kirish olib tashlanmaydi: Clerk'da yoqilgan holda qoladi. Keyinroq (veb-sayt va mobil ilova bosqichida) o‘quvchi mavjud hisobiga Google'ni *ulaydi*. Hozir Google bilan ro‘yxatdan o‘tgan o‘quvchilar avvalgidek ishlashi kerak.

## Nima uchun shunday

Telegram Mini App'ga imzolangan `initData` keladi. Bu ma'lumot o‘quvchining shaxsini tasdiqlaydi va serverda allaqachon tekshiriladi (`verifyTelegramLaunch`). Brauzer va Google orqali o‘tadigan joriy yo‘lda (`docs/telegram-browser-login.md`, `MINI_BROWSER_LINK_URL`) 4–5 marta ilovalar orasida o‘tiladi. Yangi o‘quvchilar aynan shu joyda to‘xtab qolyapti.

## Texnik yondashuv (mavjud kodni qayta ishlatish)

Talab: Clerk saqlanadi, sessiya tizimi o‘zgarmaydi, parallel backend yozilmaydi. O‘quvchining Clerk hisobini **server o‘zi yaratadi**, Mini App esa unga **bir martalik kirish tokeni** (Clerk sign-in token, `ticket` strategiyasi) bilan foydalanuvchiga ko‘rinmasdan kiradi. Undan keyin **mavjud atomik kirish** ishlatiladi: `/api/v1/auth/telegram/entry`, `TelegramClerkEntryRows.enter`. U kabinetni yaratadi, Telegram'ni bog‘laydi va sessiya beradi. Hozir u o‘chiq holatda turgan nomzod (`apps/mini-app/src/TELEGRAM-ATOMIC-ENTRY.md`).

### 1. Backend: yangi endpoint `POST /api/v1/auth/telegram/register`

So‘rov tanasi: `{ init_data, first_name, last_name }`.

1. `init_data`ni mavjud `verifyTelegramLaunch` bilan tekshir. Bu yerda replay yozuvi **yozilmasin**: `init_data` keyin atomik kirishda iste'mol qilinadi.
2. Ism va familiyani serverda tekshir: bo‘sh joylarni kesib tashla; har biri 1–64 belgi; harflar, defis, apostrof (‘ ’ ' ʻ) va bo‘sh joyga ruxsat; boshqaruv belgilari taqiqlanadi.
3. Agar bu Telegram ID allaqachon kabinetga bog‘langan bo‘lsa (`locate_telegram_return`), hech narsa yaratma va `{ status: "already_registered" }` qaytar. Mini App bu holda `resume` yo‘liga o‘tadi.
4. Clerk Backend API'da `external_id = "tg:<telegram_user_id>"` bo‘yicha foydalanuvchini qidir. Topilmasa, yangisini yarat: `first_name`, `last_name`, `external_id`, `skip_password_requirement: true`. Email va parol berilmaydi. Shunday qilib bitta Telegram uchun ikkinchi Clerk hisobi paydo bo‘lmaydi. Topilgan Clerk foydalanuvchisi boshqa kabinetga bog‘langan bo‘lsa, `IDENTITY_LINK_CONFLICT` qaytar.
5. Shu foydalanuvchi uchun qisqa muddatli sign-in token yarat (`POST /v1/sign_in_tokens`, `expires_in_seconds` 120–300). Faqat tokenni qaytar: `{ status: "ticket", ticket }`. Clerk foydalanuvchi ID'si va boshqa ma'lumot qaytarilmaydi.
6. Telegram ID bo‘yicha oddiy cheklov qo‘y: masalan, 10 daqiqada 5 ta so‘rov.
7. Clerk secret key API Worker'da allaqachon bor bo‘lishi kerak (`clerk-provider.ts` foydalanuvchini o‘qiydi). Uni tekshir. Yangi maxfiy kalit kerak bo‘lsa, uni o‘zing qo‘shma: nomini menga ayt.
8. Endpoint bayroq bilan yoqiladi, masalan `UA_TELEGRAM_REGISTER_ENABLED`. Standart qiymati o‘chiq.

Kontrakt: `contracts/telegram-return.openapi.json`ga yangi endpointni qo‘sh va `tools/generate-*.mjs --check` o‘tsin.

### 2. Mini App

- Telegram ichida `resume` `TELEGRAM_LINK_REQUIRED` qaytarsa (ya'ni yangi o‘quvchi), Clerk oynasi o‘rniga yangi **«Ism va familiya»** oynasini ko‘rsat. Oyna sodda bo‘lsin: sarlavha, 2 ta maydon, bitta katta tugma, o‘zbekcha matn.
- «Davom etish» bosilganda tartib quyidagicha. Foydalanuvchi faqat «Kabinet tayyorlanmoqda…» yozuvini ko‘radi.
  1. `POST /auth/telegram/register` chaqiriladi.
  2. `signIn.create({ strategy: 'ticket', ticket })` (yoki `signIn.ticket`), so‘ng `setActive`.
  3. Yangi Clerk tokeni va o‘sha `init_data` bilan mavjud atomik kirish chaqiriladi: `/api/v1/auth/telegram/entry`, `confirmation: "link-telegram-account-v1"`.
  4. Qaytgan sessiya bilan kabinet ochiladi.
- Xato bo‘lsa, o‘zbekcha qisqa xabar va **«Qayta urinish»** tugmasi chiqsin. Hech qachon Clerk yoki Google oynasiga qaytarilmasin.
- Guruh taklifi (`?invite=` yoki `start_param`) yo‘qolmasin: kabinet ochilgandan keyin avvalgidek taklif oynasi chiqsin.
- Mini App bayroq bilan yoqiladi, masalan `VITE_TELEGRAM_QUICK_REGISTER=true`. Standart qiymati o‘chiq.

### 3. Bot

- Yangi o‘quvchiga (`needs_clerk`) endi «Brauzerda kirish» yoki «Kirish / Ro‘yxatdan o‘tish» emas, **«Kabinetni ochish»** tugmasi yuborilsin: `web_app`, `MINI_CABINET_URL`. Matni: «Assalomu alaykum! UniverAcademy’ga xush kelibsiz. Kabinetingizni ochish uchun tugmani bosing.»
- Bu bot bayrog‘i bilan boshqarilsin (masalan, `TELEGRAM_QUICK_REGISTER=true`), shunda eski yo‘lga bir zumda qaytish mumkin bo‘ladi.
- Kod joyi: `apps/telegram-bot/src/login-message-lifecycle.mjs` (`sendLogin`) va `returning-worker.mjs`. Jonli yo‘l `TELEGRAM_MESSAGE_LIFECYCLE_ENABLED=true` orqali Durable Object'dan o‘tadi.
- Eski brauzer yo‘li (`/telegram-link`) kodda qoladi, faqat yangi o‘quvchilarga taklif qilinmaydi.

## Tekshirib, menga javob berishing kerak bo‘lgan savollar

1. `requireFreshDeletionProof` `ticket` bilan endigina kirgan Clerk sessiyasini «yangi tasdiqlangan» deb qabul qiladimi (`fva` va shu kabi)? Qabul qilmasa, eng xavfsiz yechim nima?
2. `initData` qancha vaqt amal qiladi (`initDataMaxAgeSeconds`)? O‘quvchi ism yozguncha muddat tugab qolmaydimi?
3. Clerk'dagi ism-familiya kabinetdagi ismga o‘tadimi (`exchangeClerkSession`)?
4. Clerk Backend API emailsiz foydalanuvchi yaratishi uchun production sozlamasida «email majburiy» (`auth_email.required_for_sign_up`) o‘chirilishi kerak. Buni loyiha egasi chat orqali alohida qiladi. **Sen Clerk sozlamalariga tegma.** Faqat kod tayyor bo‘lgach shuni eslat.

## Ish tartibi va chegaralar

0. **Avval:** lokal repoda push qilinmagan ~20 ta o‘zgargan fayl bor (`git status`). Ular nima ekanini 3–5 oddiy gapda menga ayt. Yangi ishni ular bilan aralashtirma: alohida branch och (masalan, `quick-telegram-register`).
1. Hamma narsa lokal bajariladi. Testlar: backend, mini-app va bot testlari (`CLAUDE.md`dagi buyruqlar). Yangi endpoint uchun test yoz: yangi o‘quvchi, qayta bosish (ikki marta bosish ikkinchi hisob yaratmaydi), allaqachon ro‘yxatdan o‘tgan o‘quvchi, noto‘g‘ri yoki eskirgan `init_data`, noto‘g‘ri ism.
2. **Push, deploy, migratsiya, Cloudflare yoki Clerk sozlamalari — yo‘q.** Bularning har biri uchun loyiha egasining alohida ruxsati kerak. Migratsiya zarur bo‘lsa, faylini tayyorla, lekin ishga tushirma va sababini ayt.
3. Yoqish tartibini yoz (qaysi bayroq, qaysi Worker, qaysi tartibda) va o‘chirish (orqaga qaytish) tartibini ham yoz. Hujjatni `docs/telegram-quick-register.md` sifatida saqla.

## Hisobot shakli (shunga qat'iy amal qil)

Loyiha egasi dasturchi emas. Hisobot **o‘zbek tilida, 15 qatordan oshmasin**, texnik atamalarsiz:

- **Nima qilindi:** 3–5 punkt, har biri bitta gap va o‘quvchiga nima foyda berishini ayt.
- **Savollarga javob:** yuqoridagi 4 ta savolga bittadan qisqa javob.
- **Sinov natijasi:** o‘tdi yoki o‘tmadi; o‘tmagan bo‘lsa, nima uchunligini bitta gapda ayt.
- **Egadan nima kerak:** aniq ro‘yxat (masalan: «Clerk'da email majburiyligini o‘chirish», «push uchun ruxsat»).

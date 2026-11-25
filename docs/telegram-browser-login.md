# Brauzerda kirish va Telegram'ga qaytish (Log In With Telegram)

Google Telegram ichidagi oynada kirishga ruxsat bermaydi (`403: disallowed_useragent`). Yangi o'quvchi shu sababli brauzerda kiradi, Telegram hisobi esa Telegram'ning rasmiy kirish oynasi ([hujjat](https://core.telegram.org/bots/telegram-login)) orqali tasdiqlanadi.

## Oqim
1. Yangi o'quvchi botda `/start` bosadi. Bot "Brauzerda kirish / Ro'yxatdan o'tish" tugmasini beradi (`MINI_BROWSER_LINK_URL`).
2. Brauzerda `https://mini.univeracademy.uz/telegram-link` ochiladi. O'quvchi Google yoki email bilan kiradi (Clerk).
3. "Telegram bilan tasdiqlash" tugmasi o'quvchini `oauth.telegram.org`ga olib boradi (OpenID Connect, kod + PKCE). Telegram ilovasida "Ruxsat berish" bosiladi.
4. Brauzer qaytadi. Sahifa faqat bir martalik kodni va PKCE tekshiruv qiymatini serverga yuboradi (`POST /api/v1/auth/telegram/browser-link`, Clerk tasdig'i bilan).
5. Server kodni Client Secret bilan almashtiradi, Telegram'ning imzolangan `id_token`ini tekshiradi (imzo, kimga mo'ljallangani, muddati, yangiligi) va aynan tasdiqlangan Telegram hisobini Clerk hisobiga bog'laydi.
6. Sahifa "Telegram'ga qaytish" tugmasini ko'rsatadi va 1,5 soniyadan keyin o'zi ham o'tkazadi (`t.me/univeracademybot`). Botda `/start` bosilganda o'quvchi "bog'langan" holatda bo'ladi va Mini App uni o'zi taniydi.

Guruh taklifi (`?invite=`) brauzer orqali ham o'tadi va qaytishda botga `start` qiymati sifatida qaytariladi.

## Nima uchun xavfsiz
- Hech qanday maxfiy havola yo'q: Telegram hisobini brauzerning o'zida Telegram tasdiqlaydi, Google/Clerk bilan bir brauzerda. Birovning havolasi orqali o'zga hisobni bog'lab bo'lmaydi.
- `state` va PKCE (S256) faqat shu brauzer oynasida saqlanadi; qaytgan kod bir marta o'qiladi va darrov o'chiriladi, manzildan olib tashlanadi.
- Client Secret faqat serverda (Cloudflare maxfiy qiymati). Brauzerga, repoga, jurnalga tushmaydi.
- Kod bir marta ishlaydi (qayta ishlatish rad etiladi), imzo faqat RS256/ES256, `iss`, `aud`, `exp` va yangilik (`iat`) tekshiriladi.
- Boshqa odamga bog'langan Telegram yoki boshqa Telegram'ga bog'langan kabinet rad etiladi (`IDENTITY_LINK_CONFLICT`).
- Yangi yo'l eski `/auth/telegram/link` va `/resume` yo'llariga tegmaydi.

## Yoqish tartibi (hammasi dastlab o'chiq)
1. Kod yuklanadi. Hech narsa o'zgarmaydi.
2. `univeracademy-api` Worker:
   - `UA_TELEGRAM_LOGIN_CLIENT_ID` = bot Client ID raqami
   - `UA_TELEGRAM_LOGIN_REDIRECT_URI` = `https://mini.univeracademy.uz/telegram-link` (BotFather'dagi Redirect URI bilan aynan bir xil)
   - `UA_TELEGRAM_LOGIN_CLIENT_SECRET` = maxfiy qiymat (secret)
   - `UA_TELEGRAM_LOGIN_ENABLED` = `true`
3. `univeracademy-mini` qurilish o'zgaruvchilari, so'ng qayta qurish:
   - `VITE_TELEGRAM_LOGIN_CLIENT_ID` = Client ID
   - `VITE_TELEGRAM_BROWSER_LINK_ENABLED` = `true`
4. `univeracademy-bot`: `MINI_BROWSER_LINK_URL` = `https://mini.univeracademy.uz/telegram-link`. Eng oxirida: shu o'zgaruvchi yoqilgach bot yangi o'quvchilarga yangi tugmani beradi.
5. Yangi Google hisobi bilan to'liq sinab ko'ring.

## O'chirish
Botdagi `MINI_BROWSER_LINK_URL` ni olib tashlang: eski tugma darhol qaytadi. Yo'lni to'liq yopish uchun `UA_TELEGRAM_LOGIN_ENABLED` ni `false` qiling.

## Ma'lum cheklovlar
- Brauzer Telegram ilovasini o'zi ocha olmaydi. Qaytish havola orqali bo'ladi: telefonda bir bosish, kompyuterda Telegram oynasi ochilishiga ruxsat so'raladi.
- O'quvchi seansi 24 soat amal qiladi. Shundan keyin Telegram ichida Clerk kirishi yana so'raladi; u yerda Google yashirilgan, email kod bilan kiriladi.
- Telegram `id_token` ichida `id` (Telegram raqami) kerak: `openid profile` ruxsati so'raladi. BotFather'da imzo algoritmini RS256 (standart) qoldiring.

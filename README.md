# UniverAcademy

Ko‘p fanli mustaqil ta’lim platformasi: veb-sahifa, o‘quvchi Mini App, Telegram bot va yagona API.

## Tuzilma

- `apps/landing/`: React tashrif sahifasi.
- `apps/mini-app/`: o‘quvchi interfeysi va autentifikatsiya oqimlari.
- `apps/telegram-bot/`: bot worker va uning testlari.
- `supabase/functions/univeracademy-api/`: backend biznes qoidalari va saqlash portlari.
- `runtime/`, `api/`: server va hosting adapterlari.
- `packages/api-client/`, `contracts/`: API mijozlari, turlar va OpenAPI kontraktlari.
- `tests/`: backend, integratsiya va xavfsizlik tekshiruvlari.

Backend modulli monolit sifatida ishlanadi. Biznes qoidalari serverda; frontendlar ularni takrorlamaydi.

## Talablar

Node.js 24.x va npm. Kontrakt generatsiyasi uchun Python 3 kerak. Har bir ilovaning o‘z package.json va lock fayli bor.

## Lokal tekshiruvlar

```sh
npm ci
npm run typecheck
npm test

npm --prefix apps/mini-app ci
npm --prefix apps/mini-app run check
npm --prefix apps/mini-app test
npm --prefix apps/mini-app run build

npm --prefix apps/landing ci
npm --prefix apps/landing run typecheck
npm --prefix apps/landing test
npm --prefix apps/landing run build

node --test apps/telegram-bot/tests/*.test.mjs
```

Root `npm test` faqat lokal backend oqimini tekshiradi; boshqa test guruhlari root `package.json` skriptlarida. Mini App testlari manba yaxlitligini tekshiruvchi guardni ham bajaradi. Test fixturelari va tarixiy kontrakt namunalari shu tekshiruvlarning kirish ma’lumotlaridir.

## Konfiguratsiya

Mini App build sozlamalari: [production.env.example](apps/mini-app/production.env.example). Originlar, Clerk va Telegram sozlamalari haqiqiy muhit uchun alohida tasdiqlanadi. Maxfiy qiymatlar repoga yozilmaydi.

`wrangler.api.jsonc`, bot konfiguratsiyasi va `vercel.json` hosting adapterlariga tegishli. API, baza, binding va Mini App hosting sozlamalarini tugatmasdan deploy qilinmaydi. Lokal test yoki build muvaffaqiyati ishlayotgan production integratsiyasini anglatmaydi. `npm start` zarur server konfiguratsiyasi berilmaguncha `CONFIG_REQUIRED` holatida qoladi.

## Ish qoidalari va litsenziya

O‘zgarish va yuklash chegaralari: [AGENTS.md](AGENTS.md). Ishlatilgan shadcn kodining [MIT bildirishnomasi](apps/landing/THIRD_PARTY_LICENSE_SHADCN.md) saqlanadi.

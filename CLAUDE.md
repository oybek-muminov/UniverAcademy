# UniverAcademy — Claude Code yo'riqnomasi

**Loyiha egasi dasturchi emas.** Hisobot va savollarni murakkab texnik atamalarsiz (hash-guard, fixture, JWT, overlay kabi so'zlarsiz), oddiy va sodda o'zbek tilida tushuntir. Har bir o'zgarish o'quvchi yoki o'qituvchiga qanday foyda berishini qisqa ayt.

Milliy sertifikat/DTM uchun online test platformasi. Hozir faqat **PILOT**: 30 o'quvchi (fizika/matematika) + 1 o'qituvchi, demo test oqimi. Pilotga kirmaydi: roadmap, video darslar, to'lov, Rasch. To'liq hujjat: `docs/PRD.md`. Ish chegaralari: `AGENTS.md`, `README.md`.

## Qat'iy qoidalar
- **`git push`** (UniverAcademy va `lab_univeracademy` repolari) — har safar alohida, aynan shu push uchun tasdiq. Oldingi rozilik, lokal tayyorlik yoki tavsiya tasdiq emas.
- Joriy topshiriqdan tashqari: migratsiya, deploy, Cloudflare/Clerk/provider sozlamalari **yo'q**.
- Supabase `academic-works` loyihasiga umuman tegilmaydi (o'qish ham, yozish ham).
- Lokal test/build o'tishi production tayyorligi emas. Jonli holat (Worker versiyalari, `keep_vars`, bayroqlar) paneldan tekshiriladi.
- Mavjud ish ustidan taxmin bilan parallel backend yozilmaydi; mavjud integratsiya/URL/identifikatorlar avtomatik migratsiya qilinmaydi.
- Maxfiy qiymatlar (`.env*`) repoga yozilmaydi.

## Tuzilma
| Yo'l | Vazifa |
|---|---|
| `supabase/functions/univeracademy-api/` | Backend biznes mantiq (yagona API egasi), saqlash portlari |
| `runtime/` | Server/hosting adapterlari (`cloudflare-worker.mjs`, `teacher-pilot-import.mjs`, ...) |
| `api/`, `vercel.json` | Eski Vercel adapteri (production — Cloudflare) |
| `apps/mini-app/` | O'quvchi Mini App (React 19 + Vite + Clerk) → Worker `univeracademy-mini` (`wrangler.jsonc`) |
| `apps/teacher-web/` | Ustoz kabineti; `ustoz-pages/` — Cloudflare Pages build (`TeacherCabinetGateway` binding) |
| `apps/telegram-bot/` | Bot Worker `univeracademy-bot` + Durable Object (`LoginMessageLifecycleObject`, `keep_vars: true`) |
| `apps/landing/` | Tashrif sahifasi (alohida package) |
| `packages/api-client/`, `contracts/` | Mijozlar, turlar, OpenAPI kontraktlari |
| `supabase/migrations/` | `cabinet-id`, `teacher-notifications`, `teacher-staging` |
| `tests/` | Backend, integratsiya, xavfsizlik testlari |

Arxitektura: modulli monolit (bitta API, bitta Postgres — Supabase `univeracademy-mvp`, Hyperdrive orqali; sxemalar `ua_private`, `ua_cabinet`). Biznes qoidalari faqat serverda; frontend ularni takrorlamaydi, client roli ruxsat uchun ishonchli emas.
Auth: Clerk. O'quvchi — custom opaque sessiya; xodim — Clerk JWT. Telegram ID topilsa Clerk ochilmaydi.
Kontrakt: joriy o'quvchi kontrakti `contracts/telegram-return.openapi.json` (qolganlari tarixiy/review). Backend yagona egasi — iste'molchi kontraktni o'zgartirmaydi, konkret diff Backendga qaytariladi.

## Buyruqlar
Node 24.x kerak (`>=24 <25`); Python 3 faqat kontrakt generatsiyasi uchun. Har ilovaning o'z `package.json`/lock fayli bor (`npm ci` har birida alohida).

**Root** (`npm run ...`)
- `typecheck` — backend + `api-client` TS tekshiruvi
- `test` — faqat lokal backend oqimi (`tests/local-content-pilot.test.mjs`); boshqa guruhlar: `test:storage-auth`, `test:persistent-http`, `test:first-test`, `test:enrollment-staff`, `test:production-client`, `test:vercel-node`, `test:clerk-auth`, `test:teacher-pilot`, `test:teacher-pilot-dom`
- `setup:validator` — validator tooling o'rnatish (ba'zi testlardan oldin kerak)
- `generate:staff-schema`, `generate:staff-types` — staff kontrakt/turlarni qayta generatsiya
- `start` — `CONFIG_REQUIRED` holatida qoladi (server konfiguratsiyasi bo'lmasa); `start:teacher-pilot` — ustoz kabinetini lokal sinash (`docs/teacher-local-pilot.md`)

**Mini App** (`npm --prefix apps/mini-app run ...`): `dev`, `check`, `test`, `build` (avval `verify-backend-targets.mjs`, keyin `tsc` + `vite build`). Brauzer testlari: `test:production-build`, `test:clerk-*-browser`.
**Landing** (`apps/landing`): `dev`, `typecheck`, `test`, `build`.
**Ustoz** : `npm --prefix apps/teacher-web test|run build`; Pages: `npm --prefix apps/teacher-web/ustoz-pages run build` va `verify`.
**Bot**: `node --test apps/telegram-bot/tests/*.test.mjs`
**CI** (`.github/workflows/production-guards.yml`) shu to'plamni ishga tushiradi, shu jumladan `tools/generate-*.mjs --check` — kontrakt/validator generatsiyasini o'zgartirsang `--check` o'tishi kerak.

Deploy buyruqlari (`wrangler deploy` va h.k.) bu yerda ataylab yo'q — ularni faqat aniq ruxsat bilan ishlat.

## Pilot biznes qoidalari
- Ustoz kabineti brauzerda ochiladi (Telegram Mini App ichida emas); o'quvchi Telegram ichida qoladi.
- Test: faol oyna + ishlash muddati (90 daqiqa); oyna tugasa majburiy yopiladi. Har javob darhol serverga saqlanadi, vaqt serverda hisoblanadi.
- Statistik bonus pilotda default `false`.
- UniverAcademy ID — 10 xonali **matn** (boshidagi nollar saqlanadi; `docs/univeracademy-id.md`).

## Joriy ustuvorliklar
1. Audit (faqat o'qish): jonli Worker versiyalari, `keep_vars`, 20–21-noyabr commit'lari deploy bo'lganmi.
2. Ustoz kabineti: brauzerda kirish, guruh, test yuklash (`runtime/teacher-pilot-import.mjs`), nashr.
3. O'quvchi oqimi: `/start` → Clerk → kabinet → test → natija (uzilishlarsiz).
4. Mini App sekin ochilishi sababi (Clerk / JS bundle / API kechikishi).

Boshqa hujjatlar: `docs/teacher-staging-pilot.md` (staging, rol tayinlash, qaytarish), `docs/MANUAL-UPLOAD-AND-ROLLOUT.md`. Eski lokal o'zgarishlar zaxirasi: `.git/local-backup-20261124/`.

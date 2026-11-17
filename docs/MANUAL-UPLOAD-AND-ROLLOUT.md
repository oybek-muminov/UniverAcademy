# UniverAcademy: ZIPni qo‘lda yuklash va xavfsiz ishga tushirish

## 1. Paket nimani beradi?

Bu paket yangi kabinet interfeysi, hisobni o‘chirish so‘rovi va natijani tiklash sahifasi, Clerk bilan tasdiqlangan Telegram hisobini atomar bog‘lash kodi hamda ularning testlarini birlashtiradi. Kodni GitHubga joylash va funksiyani productionda yoqish ikki alohida ishdir. ZIP ichida productionga tayyor, tasdiqlangan baza migratsiyasi yoki o‘rnatilgan recovery scheduler bor deb hisoblamang.

Asosiy snapshot: `3d4afd1a55918775eb3cbd2da7a004e19d37a6b8`. Paket yig‘ilganidan keyingi test natijalari alohida yakuniy tekshiruv hisobotida beriladi. Eski hujjatlardagi test sonlari shu yakuniy holatning isboti emas. Haqiqiy Clerk/Telegram/brauzer orqali to‘liq kirish–o‘chirish–qayta ro‘yxatdan o‘tish testi hali alohida talab qilinadi.

## 2. GitHubga yuklashdan oldin

1. Joriy `main` commitini yozib oling va repozitoriyning tiklanadigan nusxasini saqlang. Cloudflare’ning amaldagi deployment identifikatorlari, build sozlamalari va binding nomlarini ham qayd eting. Maxfiy qiymatlarni hisobot yoki GitHubga ko‘chirmang.
2. Joriy `main`ni yuqoridagi snapshot bilan solishtiring. Keyingi o‘zgarishlar bo‘lsa, ZIP bilan butun repozitoriyni ustidan yozmang. Faqat tekshirilgan fayl o‘zgarishlarini birlashtiring, konfliktlarni ko‘rib chiqing va testlarni qaytadan bajaring.
3. Cloudflare GitHub integratsiyasi `main`ga commit kelganda avtomatik deploy boshlashi mumkin. Qaysi Worker qaysi katalog va buyruqdan build qilishini oldindan tekshiring. GitHub Actions yashil bo‘lishi Cloudflare deploy undan keyin ketishini o‘z-o‘zidan kafolatlamaydi.
4. Amaldagi flaglarni tekshiring. `keep_vars: true` mavjud eski qiymatlarni saqlashi mumkin: koddagi default-offga suyanib, live flag ham o‘chiq deb taxmin qilmang. Tasdiqlanmagan release hold yoki oldingi xavfsizlik rad javobini chetlab o‘tmang.
5. Birinchi source-only yuklashda yangi imkoniyatlar o‘chiq qolsin: `UA_TELEGRAM_ATOMIC_ENTRY_ENABLED=false`, `UA_DELETION_REQUEST_ENABLED=false`, `UA_DELETION_RECOVERY_ENABLED=false`; frontend buildda `VITE_TELEGRAM_ATOMIC_ENTRY=false`, `VITE_ACCOUNT_DELETION_ENABLED=false`. Production sozlamasini o‘zgartirishni tegishli vakolat bilan bajaring. Agar ilgari o‘chirish so‘rovlari qabul qilingan bo‘lsa, recovery’ni o‘chirish emas, 8-bo‘limdagi xavfsiz to‘xtatish qoidasini qo‘llang.

## 3. ZIP tarkibi va qo‘lda yuklash

ZIPni oching va loyiha ildizidagi fayllarni o‘sha ildizga joylang; qo‘shimcha ichma-ich `univeracademy/univeracademy` katalogini yaratmang. GitHub veb interfeysidagi **Add file → Upload files** orqali o‘zgarishlarni yuklash mumkin. Katta yoki ko‘p faylli paketda mahalliy Git orqali bir commit qilish aniqroq. Bu yo‘riqnoma avtomatik push bajarmaydi.

Yashirin `.github/workflows/production-guards.yml` ham yuklanganini tekshiring. `package-lock.json`lar, kontraktlar, testlar, review manifest va guard o‘zgarishlari kod bilan bir commitda bo‘lsin. Faqat ZIP faylning o‘zini repoga yuklash ishlaydigan manba kodini yangilamaydi. Paketdan chiqarib tashlangan mahalliy fayllar repozitoriydan o‘chirilishi kerak degani emas.

Paketga kiritiladigan manba guruhlari:
- `apps/mini-app/`: kabinet, auth/deletion host, recovery sahifasi, klient va testlar;
- `runtime/`, `supabase/functions/univeracademy-api/`: API, atomar kirish, deletion va recovery kodi;
- `packages/api-client/`, `contracts/`: klient va qo‘shimcha review kontraktlari;
- `supabase/proposals/`: faqat ko‘rib chiqish uchun SQL, production migratsiyasi emas;
- `tests/`, `tools/`, `docs/`, `.github/`, zarur root konfiguratsiya va lockfayllar.

Paketga KIRITILMAYDI: `.git/`, `node_modules/`, `dist/`, vaqtinchalik build/test natijalari, haqiqiy `.env` va `.dev.vars`, parol yoki credential fayllari, brauzer profillari, mahalliy PostgreSQL ma’lumotlari, maxfiy loglar, foydalanuvchi ma’lumotlari. Clerk secret, Telegram bot tokeni va baza paroli hech qachon GitHubga yozilmaydi. Faqat maxfiy qiymatsiz, aniq belgilangan namuna konfiguratsiyalar saqlanishi mumkin.

Arxiv uchun alohida fayllar ro‘yxati va SHA-256 manifesti saqlansin. `apps/mini-app/tests/fixtures/backend-account-deletion-review-manifest.json` tanlangan xavfsizlikka tegishli manbalarni tekshiradi; bu butun ZIP manifesti o‘rnini bosmaydi.

## 4. Mahalliy/CI tekshiruvi

Node 24.x, Linux muhitida loyiha ildizidan:

```sh
npm ci --ignore-scripts
npm run setup:validator
npm ci --prefix tests/account-deletion/tooling
npm ci --ignore-scripts --prefix apps/mini-app
npm run typecheck
node tools/generate-account-deletion-pins.mjs --check
node apps/mini-app/tests/verify-backend-targets.mjs
node --test tests/account-deletion/*.test.mjs tests/telegram-entry/*.test.mjs
node --test apps/mini-app/tests/account-deletion-*.test.mjs apps/mini-app/tests/telegram-atomic-*.test.mjs
node tests/account-deletion/run-native.mjs
node tests/telegram-entry/run-native.mjs
npm --prefix apps/mini-app run build
```

Native testlar ajratilgan vaqtinchalik lokal PostgreSQLda ishlaydi, production DB URL bermang. Ikkita native runnerni ketma-ket bajaring; parallel ish port to‘qnashuviga olib kelishi mumkin. Linux CI’dagi qolgan regressiyalar ham `.github/workflows/production-guards.yml` bo‘yicha o‘tsin. Dashboardning yangi testlari va to‘liq Mini App suite ham yakuniy paket bilan qayta bajarilsin. Bu muhitda Chromium ishga tushishi `socket() EPERM` bilan bloklangan. Shu sabab haqiqiy brauzer vizual testi va Clerk/Telegram E2E natijasi tasdiqlanmagan; unit test yoki build buni almashtirmaydi.

Pin tekshiruvi yiqilsa, manifestni CI ichida ko‘r-ko‘rona yangilamang. Sababni tekshirib, manba + manifest + guard o‘zgarishini birga mustaqil ko‘rib chiqing. Yangi testni o‘tkazib yuborish yoki himoyani olib tashlash yechim emas.

## 5. Baza: hozir qo‘llash mumkin bo‘lmagan qism

`supabase/proposals/account-deletion-rebuild.review.sql` ichida `ua.review_deletion_install=isolated-fixture` himoyasi bor va boshqaruv holati o‘chiq yaratiladi. **Bu himoyani productionda sun’iy o‘rnatib SQLni ishga tushirmang.** `INACTIVE_REVIEW_SQL` chiqishi to‘g‘ri xavfsizlik to‘sig‘i. Native fixture ACL o‘rnatish buyruqlarini ham productionga nusxalamang.

Production uchun alohida ko‘rib chiqilgan migratsiya quyidagilarni amaldagi katalog bilan solishtirishi kerak:
- ustunlar, domain/CHECK, FK, default, trigger, RLS, ownership va SECURITY DEFINER funksiyalari;
- profilga yozuvchi barcha yo‘llar, shu jumladan staff audit/receipt actor/target yozuvlarining freeze qamrovi;
- mavjud kirish/provisioning yo‘llari, atomar Telegram tranzaksiyasi va eski fallbackni yopish bilan muvofiqlik;
- lock, lease, qayta urinish, rollback va other-person/shared yozuvlar saqlanishi;
- issuer/subject, profil UUID, receipt/proof digest tombstonelarining saqlash muddati. Completed receipt holati 24 soatdan so‘ng eskiradi, tombstonelar uchun alohida retention qarori kerak.

Huquqlarni minimal va alohida saqlash:
- `ua_api_login`: odatiy API/kirish; admin emas;
- `ua_deletion_request_login`: faqat tasdiqlangan prepare/status va kerakli session lookup/context huquqlari;
- `ua_deletion_recovery_login`: faqat due/claim/mark/finish oqimi;
- `ua_deletion_executor`: NOLOGIN, NOBYPASSRLS, runtime rollariga membership berilmaydi.

Haqiqiy imzolar va aniq GRANTlar migratsiya auditida olinadi. Umumiy `GRANT ALL`, superuser, BYPASSRLS yoki keng executor membership bermang. Mavjud writerlar uchun narrow freeze-helper EXECUTE huquqlari ham audit qilinishi kerak; aks holda oddiy yozuvlar fail-closed to‘xtashi mumkin. **Production rol/ACL o‘zgarishidan oldin egadan aynan shu o‘zgarishlar bo‘yicha alohida tasdiq talab qilinadi.** Hozirgi ZIP bunday tasdiq o‘rnini bosmaydi.

## 6. Aniq binding va flaglar

### API Worker

- Mavjud `HYPERDRIVE`: normal API va atomar Telegram kirishi.
- `UA_TELEGRAM_ATOMIC_ENTRY_ENABLED`: faqat `true` bo‘lsa yangi atomar oqim yoqiladi.
- `UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES`: JSON array, masalan amaldagi tekshirilgan Mini originlardan iborat. Mavjud Clerk `authorizedParties` to‘plamining aniq qismi bo‘lishi kerak. Request Origin asosida ishonch berilmaydi.
- `UA_DELETION_REQUEST_ENABLED`: `true` yangi so‘rovni qabul qiladi; `false` yangi so‘rovni yopib statusni saqlaydi; umuman yo‘q bo‘lsa deletion endpointlari mavjud emas.
- `HYPERDRIVE_DELETION_REQUEST`: faqat `ua_deletion_request_login` bilan alohida binding.
- Mavjud `UA_CLERK_PROVIDER_SETTINGS`, `UA_CLERK_SECRET_KEY`, `UA_API_ORIGIN`, `UA_ALLOWED_ORIGINS` va Telegram tekshiruviga zarur mavjud bot/session sozlamalari saqlanadi. Issuer, audience va authorized party siyosatini taxminan almashtirmang.

### Alohida recovery Worker

Entry: `runtime/account-deletion-recovery-worker.mjs`. Alohida deployment/cron konfiguratsiyasi hali tayyorlanib tasdiqlanishi kerak. Bu HTTP orqali trigger qilinadigan API emas; barcha HTTP so‘rovlar 404.

Faqat quyidagi besh binding/variable qabul qilinadi, API Workerning qolgan envlarini unga ko‘chirmang:

- `UA_DELETION_RECOVERY_ENABLED`;
- `HYPERDRIVE_DELETION_RECOVERY`, login `ua_deletion_recovery_login`;
- `UA_CLERK_ISSUER`;
- `UA_CLERK_INSTANCE_ID`;
- `UA_CLERK_SECRET_KEY`.

Scheduler yoqilganda mavjud pending ishlar bajarilishi, jumladan Clerk hisobi haqiqatan o‘chirilishi mumkin. Shuning uchun uni faqat DB migratsiyasi, huquqlar, provider identity readiness, monitoring va rollout tasdiqlangach yoqing. Har chaqiruv ko‘pi bilan 3 ishni oladi; tezlik, backlog va nosozlik monitoringi alohida sozlanadi. Hyperdrive cache o‘chiq, origin TLS tekshiruvi yoqilgan bo‘lishi kerak. Admin parolini runtimega bermang.

### Mini App build

Mavjud tasdiqlangan `VITE_AUTH_ENTRY=common`, `VITE_CLERK_SDK_ENABLED=true`, `VITE_TELEGRAM_SDK_ENABLED=true` va origin/publishable key/kontrakt pin qiymatlarini saqlang.

- `VITE_TELEGRAM_ATOMIC_ENTRY=true`: yangi account-choice + atomar kirish UI;
- `VITE_ACCOUNT_DELETION_ENABLED=true`: haqiqiy deletion host va kabinet tugmasi integratsiyasi;
- `VITE_MINI_APP_ORIGIN`, `VITE_API_ORIGIN`: tekshirilgan haqiqiy HTTPS originlar.

`VITE_*` build paytida klientga ochiq yoziladi. U yerga hech qachon secret key joylamang. Flag o‘zgarishi uchun qayta build kerak. Default-off source upload tugmani jonli ishlaydigan qilib qo‘ymaydi.

## 7. Ishga tushirish tartibi

1. Source merge, manifest, regressiya va mustaqil auditni yakunlang; yangi flaglar o‘chiq bo‘lsin.
2. Tiklash nusxasi va production katalog farqlarini tekshiring. Alohida migration/ACL rejasini tasdiqlating; faqat shundan so‘ng boshqaruv o‘chiq holda o‘rnating.
3. Alohida request/recovery Hyperdrive bindinglarini, cache/TLS va aniq rollarni tekshiring. Production Clerk instance/issuer/secret mosligini **read-only** readiness tekshiruvi bilan isbotlang. Soxta 404ni haqiqiy foydalanuvchi yo‘q deb qabul qilmang.
4. API va recovery kodini disabled holatda deploy qiling. Status route, CORS, SPA `/account-deletion-status`, log redaction va monitoringni tekshiring. Recovery scheduler configini audit qiling, hali ishlarni boshlatmang.
5. Atomar Telegram oqimini koordinatsiyalangan API+Mini relizda yoqing. Backend eski `/auth/telegram/link`ni yopadi va tegishli Mini signed `azp`ni eski `/auth/clerk`dan chiqaradi. Old UI/new API yoki new UI/old API vaqtinchalik mos kelmasligi mumkin; release oynasi va qaytish rejasini oldindan belgilang. Oddiy web authorized partylariga zarar bermang.
6. Ruxsat etilgan haqiqiy foydalanuvchi bilan kirish, account-choice/reverification, yangi kabinet, qayta kirish va account switchni tekshiring. Xato paytida boshqa odam kabineti ochilmasin; shubhali natija avtomatik qayta POST qilinmasin.
7. Deletion qabul qilishdan **oldin** provider readiness, bazadagi boshqaruv va recovery schedulerning ishlashi tekshirilsin. Tasdiqlangan tartibda recovery tayyorlanadi, keyin request qabul qilish, so‘ng Mini deletion UI yoqiladi. Tasodifiy pending job yo‘qligi ham tekshirilsin.
8. Birinchi haqiqiy o‘chirish faqat tanlangan hisob va oqibatlar uchun egasining ayni paytdagi aniq roziligi bilan bajariladi. Jarayon bazadagi akkaunt, Clerk va Telegram bog‘lanishini tekshiradi; Clerk-only hisoblarni qidirib ommaviy o‘chirmaydi.
9. Tasdiqlangan testda accepted → recovery → completed, keyin o‘sha Telegram bilan yangi ro‘yxatdan o‘tish sinovdan o‘tsin. Tarmoq uzilishi, noaniq javob va boshqa tab/account holati ham tekshirilsin. Test hisobotiga shaxsiy ma’lumot yoki receipt yozmang.

## 8. Nosozlik va rollback

Yangi so‘rovlarni to‘xtatish uchun request flagni `false` qiling va Mini deletion UI’ni o‘chiring. Status binding/route va recovery saqlansin. `false` va flagni butunlay olib tashlash bir xil emas: olib tashlash foydalanuvchining status tekshiruvini ham yopadi.

Accepted yoki provider-deleted ishni oddiy kod rollback bilan bekor qilib bo‘lmaydi. **Profilni unfreeze qilmang, job/tombstoneni o‘chirmang, userni reset qilmang.** Clerkdagi o‘chirish tugagan, DB yakuni noma’lum bo‘lsa, xavfsiz recovery keyingi urinishda shu ishni tugatadi. Eski kodga qaytish freeze/status/recovery himoyasini chetlab o‘tmasligi kerak. DB backupni qaytarish Clerkdagi o‘chirilgan hisobni tiklamaydi.

Timeout, 404/expired receipt yoki noaniq javob “hisob o‘chirildi” degani emas. Receipt shu qurilmada saqlanadi, URL/logga chiqmaydi. Faqat server `completed`ni tasdiqlagach lokal receiptni unutish mumkin. Saqlangan receipt yo‘qolsa, tasodifiy yangi delete urinish o‘rniga operator tekshiruvi talab qilinadi.

## 9. Aktivatsiyadan oldin ochiq qolgan talablar

- To‘liq production DDL/RLS/writer-parity va alohida approved migration/ACL.
- Haqiqiy Clerk instance readiness, reverify va Telegram/browser E2E.
- Alohida recovery deploy/cron/binding/TLS/cache va monitoring.
- Atomar kirish va eski fallbackning koordinatsiyalangan relizi.
- Tombstone retention, backup va provider-deleted rollback siyosati.
- Birlashtirilgan dashboard+deletion paketining yakuniy test/audit natijasi va secret-scan.

Bu talablar tugamaguncha source ZIPni yuklash mumkinligi funksiyani productionda yoqishga ruxsat yoki muvaffaqiyat isboti emas.

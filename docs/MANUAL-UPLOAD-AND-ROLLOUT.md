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

## 10. 2026-11-18 real-account-only continuation

The owner's latest direction governs all further validation: use the real project
and the already designated real account. Do not create synthetic data/accounts or
run synthetic fixtures. If another real account or a populated group is required,
ask first. Earlier fixture results are historical engineering evidence, not the
owner's accepted real-project completion criterion. Do not include newly created
synthetic fixture/test files in an upload package without explicit authorization.

Current blockers, in dependency order:

1. **Managed production migration.** The two `*.review.sql` files require an
   isolated-fixture marker and must not be used on production by setting that
   marker. A separate reviewed production composition is needed. It must preserve
   the observed managed `postgres` ADMIN-only memberships, explicitly bound any
   temporary owner/SET/CREATE authority, and prove that authority is closed before
   completion. The observed baseline has no deletion tables or roles.
2. **Dedicated credentials and infrastructure.** Two named restricted runtime
   logins and separate Hyperdrive bindings must be provisioned through the
   approved secret/configuration flow. Keep secrets out of source and chat.
   Confirm TLS verification, disabled query cache, actual current_user and narrow
   effective privileges. Do not replace the ordinary API's broader binding.
3. **Disabled deployment first.** API and recovery Worker are deployed with
   acceptance and recovery disabled; Mini deletion UI remains off. Verify exact
   source/version, origin/CORS/status routing, provider instance/domain readiness,
   redacted logs and monitoring without accepting a deletion job.
4. **Real-account readiness.** Have the owner sign in to the previously designated
   account and complete reverification. Verify identity continuity and cancellation
   through the real UI. Do not use an old bearer/token from logs or export session
   material. The designated account had no attempts/results at the last read-only
   check: testing real education cleanup requires the owner's genuine activity,
   not an inserted fixture. A second-user preservation test needs an additional
   real account selected by the owner if the current set is insufficient.
5. **Explicit destructive confirmation.** Before the first actual delete submit,
   display the exact account and explain that Clerk identity, platform profile,
   personal results and Telegram binding will be removed; DB backup alone cannot
   restore the Clerk identity. Obtain the owner's fresh concrete confirmation.
   General past willingness to accept test risk is not this confirmation.
6. **Activation and completion.** Independently check an empty pending queue,
   scheduler/provider readiness and the approved rollout scope before enabling
   submission. Follow accepted→provider-deleted→completed via receipt status and
   read-only counts, without automatic retries of ambiguous submits. Never unfreeze
   or resurrect a provider-deleted job as a rollback shortcut.

Approval boundaries remain separate: source upload, managed DB/configuration
change and deployment must be within their concrete approved scope; the actual
irreversible account deletion additionally requires action-time confirmation.
No step above is recorded as performed by writing this plan.

### Managed production composition candidate, prepared but not applied

`supabase/proposals/account-deletion-managed-production.candidate.sql` now supplies
an actual managed-operator composition for independent review, rather than asking
an operator to bypass the isolated-fixture guard. It is NOT a migration-history
record and has never been executed. No credentials or real-account identifiers
are embedded.

Design:
- One transaction; accepts only the observed PostgreSQL17.11 managed `postgres`
  operator, database and bootstrap-role/membership shape.
- Pins a read-only catalog fingerprint before changes. Any baseline drift or
  existing deletion roles aborts; there is no broad IF NOT EXISTS overwrite.
- Creates three restricted NOLOGIN roles and verifies their bootstrap-issued
  ADMIN-only creator rows. No LOGIN or password is supplied.
- Opens separate operator-granted temporary INHERIT/SET edges for ua_owner,
  ua_access_locator_owner and ua_deletion_executor. Destination schema CREATE is
  temporary and applies only to the new executor for function ownership transfer.
- Uses the corrected deletion business SQL verbatim. Adds tables with acceptance
  false; leaves jobs/tombstones empty. New table ownership becomes ua_owner.
- Normalizes ACLs on NEW objects only, then grants exact request/recovery/helper
  execution. It does not rewrite existing unrelated default privileges.
- Revokes temporary schema CREATE and operator-granted membership edges while
  preserving original bootstrap ADMIN-only edges; postflight verifies closure,
  role attributes, RLS, table ownership and exact new-function ACLs before COMMIT.

Static validation only: pglast7.23 using PostgreSQL17 grammar parsed72 SQL
statements and20 PL/pgSQL blocks; the business SQL block is byte-identical to the
corrected review source. `git diff --check` passed. Parsing does not establish
permission behavior or production success; no database execution or synthetic
fixture was used for this candidate.

Independent review must examine the managed ownership/GRANTOR window, source
fingerprint stability, effective ACL checks and DDL lock impact before approval.
Schedule a quiet maintenance window: new triggers/policies require locks, and a
catalog snapshot does not defend against a concurrent administrator changing
DDL/ACL after the initial check. Approval marker text is only an accident guard,
not a substitute for the owner's concrete authorization. Never set it just to
make a rejected command pass. Keep UI/recovery disabled and NOLOGIN placeholders
unchanged until the separately approved credential/binding/deployment steps.

The only persistent row inserted during installation is the disabled singleton
control row. No profile, test attempt, result, accepted job or provider deletion
is created by installation. A backup restore cannot undo a later Clerk deletion.

### Reviewer correction: disabled acceptance is not a no-impact install

The initial production composition attached enabled barriers immediately. That
would change ordinary writes even with accepting=false. The revised candidate
now leaves **all31 newly added barriers DISABLED at commit**, adds
`guards_active=false`, and enforces `CHECK (NOT accepting OR guards_active)`.
This avoids persistent per-row helper/locking impact in the installed state;
it does NOT remove DDL lock/planning/catalog impact during installation. A quiet,
separately approved maintenance window remains necessary.

Read-only effective-writer audit of the real project found:
- ua_api_login inherits ua_runtime: DML capability on15 private tables.
- ua_clerk_lock_owner can update people/clerk_identities; its actual linking
  function performs UPDATE on people.
- ua_person_lock_owner has people UPDATE privilege needed for its current
  SELECT FOR UPDATE helper. That helper currently issues no row mutation.
- ua_owner owns30 tables and is relevant during approved maintenance windows.
- supabase_admin is a platform superuser. The predefined pg_write_all_data role
  represents broad capability, not a provisioned application login. Any future
  non-superuser membership in that role is an activation blocker.
- No ua_* connections were visible at the observation instant. That does not
  prove absence of traffic or certify a maintenance window.

The revised production ACL adds only the narrow row-freeze helper to ua_owner
and ua_person_lock_owner, and the staff helper to ua_owner. ua_api_login obtains
its existing guard access through ua_runtime. No executor membership, table
rights or credential is added to these existing writers. The exact-function
postflight allowlist is updated accordingly. Do not distribute the helper to
PUBLIC, service_role or every role as a workaround for permission errors.

`account-deletion-guard-rollout.candidate.sql` provides a separate reviewed stage:
1. Keep API acceptance/recovery/UI off. Confirm backup, deployment compatibility,
   actual writer inventory, production identity pins and the approved real-account
   observation plan. No synthetic probes are allowed.
2. In an approved quiet window, enable mode takes deterministic ACCESS EXCLUSIVE
   NOWAIT locks on the25 affected tables and four control/history tables. Busy
   tables cause a rollback, not automatic retry or session termination. It checks
   the exact31 barriers, owner/path/state, empty jobs/tombstones and narrow effective
   writer helper ACLs before enabling. It leaves accepting=false.
3. Observe genuine intended activity through the real project and designated
   account: sign-in/return, profile update if explicitly included, normal result
   write if the owner has genuine educational content, cancellation and session
   behavior. Inspect only redacted errors/lock-wait metrics and count/status
   metadata. One successful login is not proof of every writer or race case.
4. Only after that checkpoint may a separately approved acceptance/UI/recovery
   activation proceed. The first irreversible account deletion still requires
   fresh action-time confirmation for the exact account.

Rollback boundaries:
- If install/guard-change fails before COMMIT: PostgreSQL transaction rollback
  restores its DDL/grants/trigger state. No partial manual cleanup or broad DROP.
- Before ANY accepted job/tombstone: stop submission/UI/recovery through the
  approved config path, verify acceptance=false, then the same guard-rollout file
  in disable-empty-guards mode can atomically disable exactly these31 barriers.
  It refuses if ANY job (even completed) or tombstone exists. Leave inert tables
  and NOLOGIN roles in place; removing them is not necessary for this rollback.
- Once a job/tombstone exists: DO NOT disable barriers, clear tombstones, unfreeze
  a profile or restore only the DB as a rollback. Stop NEW submissions, retain
  receipt status and reconcile accepted work. If a wrong-target/provider risk is
  suspected, stop the recovery scheduler first and investigate while preserving
  all guards and records. Resume only under the clarified approved scope.
- Neither row triggers nor these gates make a malicious privileged administrator
  safe. Owner/superuser TRUNCATE or arbitrary DDL remains outside the runtime
  protection boundary and must not be used as a maintenance shortcut.

These changes were statically parsed only: PostgreSQL17 grammar accepted the
revised install (75 statements/21 PL/pgSQL blocks) and separate rollout
(10 statements/3 blocks). No script was executed, no synthetic data was created,
and no production write occurred. Independent review is required again.

#### Second review corrections (not executed)

The managed candidate's prepare predicate is now explicitly
`accepting AND guards_active`. The earlier `accepting OR guards_active` was an
incorrect broad text-replacement and would have admitted deletion during the
guard-only observation phase. It is fixed. Other OR expressions are rejection
conditions or the implication CHECK and are intentionally unchanged. The
production function body therefore differs from the base review source at this
one deliberate admission gate; earlier byte-identical evidence describes the
pre-staging copy, not this revised production body.

The rollout candidate additionally pins exact MD5 hashes of the reviewed prosrc
text for all five guard functions, with their exact signatures, expected owner,
PL/pgSQL language, SECURITY DEFINER/INVOKER setting, fixed configuration,
volatility/parallel/strict/leakproof/return/default-argument properties. Hashes
are drift checks, not protection against a malicious administrator.

All31 triggers are checked for exact timing/event bitmask, row mode, target and
function, UPDATE column list, absence of WHEN, exact argument bytes/count, and
non-constraint/non-deferred semantics, in addition to expected enabled state.
The six identity/proof triggers distinguish BEFORE vs AFTER and Clerk vs Telegram
arguments. A same-name trigger with a different event, WHEN filter or argument
now fails closed rather than being enabled. PostgreSQL17 static parsing and
whitespace checks passed; no runtime or synthetic test was performed.

## Latest continuation: source preparation does not wait for backup

The owner directed that completion of the separate backup project must not block
independent account-deletion implementation. Continue source, configuration and
read-only readiness work now. This is not permission to delete a real account,
push without the repository's per-upload approval, or change production ACLs
without the concrete security-change approval. Keep those decisions separate.

`wrangler.account-deletion-recovery.jsonc` is now the disabled deployment candidate:
no public/preview routes, no cron, enabled=false, verified issuer/instance pins.
The dedicated Hyperdrive and secret must be provisioned separately. Preserve the
strict five-binding runtime contract. The JSONC structure and disabled invariants
were statically checked; root TypeScript check passed. This is not an executed
provider deployment or a verified real-account E2E result. See the official
[Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/).

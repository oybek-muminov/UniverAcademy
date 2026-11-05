# Agentlar mas’uliyati

Holat: boshlang‘ich taqsimot taklifi. Ushbu fayl agentlar yaratilgani yoki kod yozilgani dalili emas.

| Mas’ul | Asosiy yo‘llar | Natija va chegara |
|---|---|---|
| Koordinator | Vazifalar, review va foydalanuvchi tasdiqlari | Topshiriq, bog‘liqlik va kontrakt versiyasini birlashtiradi; API egaligini almashtirmaydi. |
| Arxitektor | docs/architecture.md, docs/ownership.md | Modul chegaralari, sodda texnik qarorlar, o‘sish mezonlari; mahsulot qoidasini o‘zicha o‘zgartirmaydi. |
| Backend | supabase/functions/univeracademy-api/**, supabase/migrations/**, docs/api/**, packages/api-client/**, tests/backend/** | Yagona API egasi; auth/scope, lifecycle/CAS/idempotency, media, baholash va natija. SQL/provider o‘zgarishlari uchun alohida konkret reja. |
| Bot/Mini App | apps/mini-app/** | Telegram launch va o‘quvchi UI; opaque sessiya, timer/save/reconcile/submit/result/review. Server qoidalarini nusxalamaydi. |
| Panel | apps/panel/** | Staff onboarding, ruxsatli roster/kontent/test boshqaruvi, monitoring/natija va optional bonus UI. Clientdagi rol authoritative emas. |
| Landing | apps/landing/** | Mavjud eksportni tekshirish va rozilikdan keyin ko‘chirish; tayyorlangan sahifani inventarsiz qayta yozmaydi. |
| QA | tests/e2e/**, tests/load/**, docs/pilot-acceptance.md | Kontraktga moslik, negativ/auth/recovery/concurrency, UI va yuklama dalillari. Offline passni production tayyorligi deb atamaydi. |

## Telegram webhook va xabarlar

Aniq mas’uliyat taklifi: inbound webhook autentifikatsiyasi, update deduplication va biznes amallari Backendga tegishli. Bot/Mini App agenti launch/UX va xabar ko‘rinishini tayyorlaydi. Outbox dispatcher kodi va ishlash muhiti mavjud inventar bo‘yicha Backend/Bot bilan kelishiladi; yangi mustaqil bot xizmati avtomatik yaratilmaydi.

## Muvofiqlashtirish

Backend aniq kontrakt versiyasi/xeshini taqdim etadi. Bot, Panel va QA ayni nusxani tekshiradi. Mos kelmaslikda client taxminiy maydon kiritmaydi; Backendga endpoint/schema va taklif qilingan diffni qaytaradi.

Bir agent boshqa agentning yo‘lidagi o‘zgarishni oldindan muvofiqlashtiradi. Aralash umumiy “shared” papka o‘rniga haqiqiy umumiy kontrakt mijozidan foydalaniladi.

Avval Backend inventar/reviewi; Bot va Panel o‘zgarmagan oqim hamda mocklarni parallel tayyorlashi mumkin. Yangi API integratsiyasi egasi ko‘rib chiqqan kontraktga bog‘lanadi. Agentlarni yaratish amaldagi topshiriq doirasida koordinator tomonidan bajariladi.


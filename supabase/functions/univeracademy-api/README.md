# Yagona API va modulli backend

Mas’ul: Backend — APIning yagona egasi.

Yangi lokal nomzod yo‘li: `supabase/functions/univeracademy-api/`. Bu faqat tayyorlanayotgan loyiha tuzilmasi; amaldagi funksiya yoki URL ko‘chirilmadi. Mavjud backendning read-only inventarisiz ishlovchi kod ustidan yangi implementatsiya yozilmaydi.

Ko‘riladigan qismlar: student/staff identity, auth/scope, groups/roster, published demo/version/media, assignment/admission, attempts/CAS/submit/recovery, ordinary/bonus snapshot, result/review/export, Telegram webhook va notifications.

Avval API 0.2.7/numeric/storage/transaction reviewi; keyin aniq modul va fayl diffi. Biznes qoidalari modul ichida, HTTP/Telegram/Supabase bog‘lanishlari kirish qatlamida ajratiladi. Kichik bonus hisobi uchun alohida worker majburiy emas.

Student custom opaque proof va staff Auth JWT aralashtirilmaydi. Provider sozlamasi, real secret, migration va deployment ushbu papka yaratilishi bilan ruxsat etilgan hisoblanmaydi.


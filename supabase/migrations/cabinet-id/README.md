# UniverAcademy ID migratsiyasi

O‘quvchining 10 raqamli ID’si, boshidagi nollar, ichki `person_id`, a’zolik va urinishlar tarixi saqlanadi. Yozishlar bitta ustun va uning mavjud UNIQUE indeksi orqali o‘tadi. Quyidagi buyruqlarni loyiha ildizidan, xizmat ko‘rsatish uchun tanlangan PostgreSQL ulanishi bilan bajarish mumkin. Ulanish uchun `pg` standart PostgreSQL muhit sozlamalarini o‘qiydi. Ilovani yangilash bu migratsiyani avtomatik boshlamaydi.

## Qo‘llash tartibi

1. PostgreSQL 15 yoki keyingi versiyadagi maqsadli muhitda tiklash nuqtasini oling. Jonli katalogni repodagi tarixiy sxema nusxasi bilan solishtiring. `ua_private.people` ustuni, unique/check, `people_profile_shape`, `registration_people_insert`, `registration_profile_update`, tegishli ACL/RLS, triggerlar va tashqi hisobotlarni tekshiring. Qo‘shimcha yozuvchi, funksiya yoki hisobot eski JSON kalitini yoki ustun nomini bevosita o‘qisa, uni ham o‘tishga moslang. DDL uchun obyektlarga egalik huquqi, backfill uchun barcha qatorlarni ko‘ra oladigan texnik ulanish kerak.
2. `node supabase/migrations/cabinet-id/migrate.mjs expand`. Yangi yozish ko‘rinishi mavjud ID ustuniga yo‘naltiriladi va asl jadvaldagi ruxsatlar bilan ishlaydi. Trigger barcha yozuvchilarning profilida eski kalitni saqlaydi. Shu bosqichda eski va yangi server birga ishlay oladi. Yangilangan registration API asl jadval bilan ham ishlaydi va bu bosqichgacha tarqatilishi mumkin. `forward`dan oldin yangilangan backend barcha faol nusxalarda ishlayotganini tasdiqlang. Eski Mini App bilan, keyin yangi Mini App bilan profilni o‘qish va o‘zgartirishni tekshiring.
3. Eski **server** nusxalarining so‘rovlari tugagach `node supabase/migrations/cabinet-id/migrate.mjs forward`. Qisqa tranzaksiya ustunni `univeracademy_id` deb qayta nomlaydi va unique/check nomlari, JSON shakli hamda ikkita RLS yozish shartini moslashtiradi. UNIQUE indeksi qayta qurilmaydi. Eski Mini App bilan ishlash yangilangan serverning javob formatini tanlashiga tayanadi. Qator yangilansa, trigger JSON kalitini ham yangilaydi.
4. `node supabase/migrations/cabinet-id/migrate.mjs backfill`. Har tranzaksiya birlamchi kalit bo‘yicha ko‘pi bilan 500 qatorni ko‘radi. Faqat eski kalitli profillar yoziladi. Oxirida skript CHECKni butun jadvalda tasdiqlaydi va eski kalit qolmaganini tekshiradi. Jarayon uzilsa, qayta ishga tushirish mumkin. Bloklangan yoki hisob o‘chirilayotgan qator migratsiyani to‘xtatsa, uning odatiy tranzaksiyasi yakunlangach takrorlang. Muayyan bazada ishlash tezligi va migratsiya vaqti alohida o‘lchanadi.

## Supabase operatori

UniverAcademy Supabase muhitida xizmat ko‘rsatuvchi `postgres` operatoriga `BYPASSRLS` va o‘qish huquqi berilgan. Uning `ua_owner` a’zoligida `ADMIN TRUE, INHERIT FALSE, SET FALSE` qayd etilgan. Qo‘llangan `expand` SQLini Supabase migration history orqali topish mumkin.

Keyingi DDL uchun operator o‘z tranzaksiyasida vaqtincha `SET` huquqini oladi, `SET LOCAL ROLE ua_owner` bilan katalogni o‘zgartiradi, asl roliga qaytadi va vaqtinchalik a’zolik grantini commitdan oldin qaytaradi. Backfill har bir 500 qatorli tranzaksiya uchun kerak bo‘lsa `UPDATE(profile)`ni vaqtincha beradi va aynan qo‘shilgan huquqni commitdan oldin olib tashlaydi. Har bosqich oxirida boshlang‘ich a’zolik va ustun ACL qiymatlari tiklanganini tekshiring.

## Ortga qaytish

`forward`gacha avvalgi serverga bevosita qaytish mumkin. `forward`dan keyin yangi serverlar so‘rovlarga xizmat qilib turganida `node supabase/migrations/cabinet-id/migrate.mjs rollback`, keyin `node supabase/migrations/cabinet-id/migrate.mjs backfill` bajariladi. Shu tekshiruv tugagach eski server yana aniq eski profil shaklini o‘qiy oladi. Eski API bilan yangi Mini App ham tarixiy profil shaklini o‘qiy oladi. Bu tartib yangi versiyada ro‘yxatdan o‘tgan o‘quvchilarning ID’larini ham saqlaydi.

## Mahalliy tekshiruv

`node tests/telegram-entry/run-native.mjs` vaqtinchalik lokal PostgreSQL klasterlarida katalogning RLS va grantlarini tiklab, Telegram orqali ro‘yxatdan o‘tish hamda oldinga/ortga migratsiyani tekshiradi. Sinovlar eski va yangi yozish yo‘llari, takroriy ID, ruxsat etilmagan profil, boshlang‘ich nollar, takroriy migratsiya va asl UNIQUE indeksining saqlanishini qamraydi.

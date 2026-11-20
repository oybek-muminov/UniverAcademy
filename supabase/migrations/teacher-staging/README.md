# O‘qituvchi kabineti uchun staging bazasi

Pilot ilgari yozilgan `ua_private` jadvallari orqali shaxs, a’zolik, test, topshiriq, urinish va ballni saqlaydi. `ua_cabinet` sxemasi guruh so‘rovi va egaligi, test egasi, xususiy PNG, taklif, bot roziligi va yetkazish tarixini saqlaydi. Ro‘yxatdan o‘tgan o‘quvchini topish uchun o‘n raqamli ID satr sifatida qidiriladi.

1. Stagingdagi `ua_private` sxemasi repo katalogi bilan mosligini tekshiring. Avval `supabase/migrations/cabinet-id/` dagi expand bosqichini bajaring. `ua_private.people_registration` ko‘rinishi eski hamda yangi fizik ustun nomlari bilan bir xil ID beradi.
2. Staging bazasi administratori `up.sql`ni bir marta qo‘llaydi. API logini uchun `ua_cabinet_stage`, tasdiqlangan bot xizmatining alohida logini uchun `ua_cabinet_delivery` roliga `SET` huquqini va `INHERIT FALSE` belgilang. API mavjud shaxsni autentifikatsiya qiladi, tranzaksiya ichida uning qatorini qulflaydi va kabinet roliga vaqtincha o‘tadi. Migratsiya login yaratmaydi va mavjud rolga a’zolik bermaydi.
3. O‘qituvchi uchun `people.roles`, `staff_access.approved`, faol `teacher_subject_approvals` va dars tayinlash uchun tegishli `staff_subject_scope` yoki tasdiqlangan kengroq fan doirasi kerak. Yagona tasdiqlangan fanni API tanlaydi. Bir nechta fan bo‘lsa, so‘rovda `subjectId` yuboriladi. Fan nomi uchun dashboard mavjud katalog ID qiymatini ko‘rsatadi. Admin `manage_roster` hamda tegishli fan yoki barcha guruhlar doirasiga ega bo‘lishi kerak. Admin tasdiqlaganda faol guruh va o‘qituvchining aniq guruh doirasi bir tranzaksiyada yaratiladi.
4. Hisobni o‘chirish tizimi stagingdan keyin o‘rnatilsa, `bind-deletion.sql`ni qo‘llang. Oldin o‘rnatilgan tizimga `up.sql` ayni yordamchi funksiyalarni bog‘laydi. O‘quvchi o‘chirilsa, shaxsiy taklif va uning yetkazish tarixi o‘chiriladi. Boshqa o‘quvchilarning a’zoligi va umumiy guruh havolasi saqlanadi.
5. Orqaga qaytarishda staging API va bot jarayonlarini to‘xtatib, tranzaksiyalar tugashini kuting, so‘ng `down.sql`ni qo‘llang. Ikki staging rolidan huquqlar qaytarib olinadi; qo‘shimcha jadvallar `ua_cabinet_retained` nomida saqlanadi. `up.sql` bu ma’lumot va egaliklarni qayta ulaydi. Hisob o‘chirilganda private chat ma’lumotlari saqlangan sxemada ham tozalanadi.

Shaxsiy bot taklifi 24 soat amal qiladi va faqat buyurtmada ko‘rsatilgan o‘quvchi hamda uning amaldagi Telegram bog‘lanishi uchun qabul qilinadi. Bot faqat ishonchli private `/start` qayd etilgach bevosita xabar bera oladi. Yetkazish uchun band qilingan xabarning natijasi noma’lum qolsa, takroriy xabarni oldini olish uchun navbat uni o‘z-o‘zidan qayta jo‘natmaydi.

Tekshiruv uchun `node --test tests/teacher-staging-pilot/store-native.test.mjs tests/teacher-staging-pilot/native.test.mjs` har bir to‘plamga yangi mahalliy PostgreSQL bazasini ishga tushiradi.

## Supabase boshqaradigan PostgreSQL 17

Supabase’dagi `postgres` bazaning egasi va rol yarata oladi. `ua_owner` asosiy jadvallarga, `ua_deletion_executor` esa o‘chirishni tekshiruvchi funksiyalarga egalik qiladi. Uch vakolat turli rollarda bo‘lganda `managed.mjs` repodagi tekshirilgan migratsiyani aynan shu sharoitga tayyorlaydi. Quyidagi buyruqlar bazaga ulanmasdan SQL fayllarini chiqaradi.

```sh
node supabase/migrations/teacher-staging/managed.mjs up > /tmp/ua_managed_cabinet_up.sql
node supabase/migrations/teacher-staging/managed.mjs down > /tmp/ua_managed_cabinet_down.sql
node supabase/migrations/teacher-staging/managed.mjs restore > /tmp/ua_managed_cabinet_restore.sql
node --test tests/teacher-staging-pilot/managed-install.test.mjs
```

1. Joriy bazaning egasi va operator huquqlarini tekshiring. Birinchi o‘rnatishda `ua_cabinet`, `ua_cabinet_retained` va ikkala kabinet roli hali mavjud bo‘lmasligi kerak. ID migratsiyasi yakunlangan, eski profil bilan mos ko‘rinish yaratilgan va tekshirilgan hisob o‘chirish funksiyalari o‘rnatilgan bo‘lishi kerak.
2. O‘rnatish tasdiqlangach, **up** faylini tanlangan bazada boshidan oxirigacha bitta tranzaksiyada bajaring. Skript eski obyektlarning egaligi va RLS holatini tekshiradi. Operator faqat tranzaksiya ichida ikki mavjud rolga o‘tadi. Yangi sxema va barcha kabinet jadvallari egasi `ua_owner` bo‘ladi. Yakuniy tekshiruv avvalgi database ACL va ikkala rol a’zoliklarini solishtiradi. Xato bo‘lsa tranzaksiyani ortga qaytaring.
3. Schema o‘rnatilgandan keyin serverga alohida `LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS` hisob yaratiladi. Unga `ua_api_login WITH INHERIT TRUE, SET FALSE` va `ua_cabinet_stage WITH INHERIT FALSE, SET TRUE` a’zoliklari beriladi. Botga ikkinchi login va faqat `ua_cabinet_delivery WITH INHERIT FALSE, SET TRUE` beriladi. Parollar serverning sirlar omboriga kiritiladi. O‘qituvchi va Adminning ilovadagi shaxsi amaldagi Clerk issuer/subject va Supabase’dagi tasdiqlangan rol/fan vakolatlari orqali bog‘lanadi.
4. Ishlayotgan xizmatni ortga qaytarishda avval ikkala xizmat jarayonini to‘xtatib, tranzaksiyalar yakunlanishini kuting. **down** ma’lumotlarni saqlab, xizmat rollaridan huquqlarni oladi. Keyin qayta ulashga qaror qilinsa, **restore** saqlangan sxema va ma’lumotlarga o‘sha huquqlarni qayta o‘rnatadi. Har bir fayl o‘z tranzaksiyasida bajariladi.

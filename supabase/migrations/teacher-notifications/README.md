# O‘qituvchiga bir martalik Telegram xabari

Bu migratsiya yangi fan vakolati uchun shaxsiy xabarni navbatga qo‘yadi. Bitta o‘qituvchining barcha fanlari bitta yozuvdan foydalanadi. Birinchi o‘rnatishda faol `people` yozuvida `teacher` roli, tasdiqlangan `staff_access` va kamida bitta faol `teacher_subject_approvals` bo‘lgan shaxslar navbatga tushadi. Keyingi tayinlashlar aniq shaxs ID bo‘yicha ishlaydi. Rol, xodim ruxsati va fan alohida tranzaksiyalarda berilishi mumkin. Yuboruvchi uchala huquqni ham xabarni olish vaqtida qayta tekshiradi.

## O‘rnatish va sinov

Kabinetning boshqariladigan PG17 migratsiyasidan keyin `001_teacher_notifications.sql`ni vakolatli operator bir marta bajaradi. SQL jadval, RLS, navbat indekslari, triggerlar hamda boshlang‘ich ro‘yxatni bitta tranzaksiyada yaratadi. Operator uchun vaqtincha berilgan `SET ROLE ua_owner` huquqi tranzaksiya tugashidan oldin qaytariladi. Telegram matni va yuborish jadvali Worker’da sozlanadi.

```sh
psql "$TEACHER_NOTIFICATION_OPERATOR_DSN" -X -v ON_ERROR_STOP=1 -f supabase/migrations/teacher-notifications/001_teacher_notifications.sql
node --test supabase/migrations/teacher-notifications/native.test.mjs
```

Mahalliy test uchun repo ildizida Node 24 bog‘liqliklari va `tests/account-deletion/tooling` paketi o‘rnatilgan bo‘lishi kerak. Sinov o‘zining vaqtinchalik PostgreSQL klasterini yaratadi.

## Qabul qilish, tasdiqlash va o‘chirish

`ua_cabinet_delivery` roli navbatni o‘qiydi va ishlov berish ustunlarini yangilaydi. Yuborish uchun operator yoki o‘quvchi API’siga jadvalga yozish huquqi berilmaydi. Jadvalga kirish uchun ham schema, ham ustun va RLS huquqlari tekshiriladi.

- Yuboruvchi `queued/retry` yozuvini olganda ayni paytdagi faol rol, xodim tasdig‘i, faol fan va shu odamga bog‘langan shaxsiy Telegram IDni tekshiradi. Faol fizika fani bo‘lsa fizikaga tegishli matnni tanlaydi. Birinchi yuborish oldindan bog‘langan chatda sinab ko‘riladi.
- `sending` holatida aynan tekshirilgan `chat_id` va yangi `claim_id` saqlanadi. Telegram 403 berganda yozuv `blocked`ga o‘tadi. Tasdiqlangan shaxsiy `/start` tranzaksiyasi avval `private_starts`ni yozadi, keyin `SELECT ua_cabinet.wake_teacher_notification($1::bigint)`ni chaqiradi. Birinchi urinishdan oldin ham mavjud bo‘lgan shaxsiy chat shu tariqa qayta uyg‘onadi. Yetkazilgani noaniq xabar qayta yuborilmaydi.
- Telegram yuborilganini tasdiqlaganda asl chat IDsi va Telegram qaytargan xabar raqami saqlanadi. Bitta vaqt qiymatidan foydalanib `sent_at`, `delete_after = sent_at + interval '24 hours'`, `delete_until = sent_at + interval '48 hours'` yoziladi. Bog‘lanish almashgan yoki odam o‘chirilgan bo‘lsa ham shu asl xabar o‘chiriladi. Muddat ichidagi o‘chirish takrori ham ayni chat va xabar raqamini ishlatadi.
- Yakuniy javob yoki muddat tugagach chat, xabar raqami, claim va yetkazish vaqtlari tozalanadi. Mavjud shaxs uchun holat takroriy yuborishni to‘xtatadi. O‘chirilgan shaxs uchun qoldiq qator avtomatik o‘chadi.

## Kabinetni orqaga qaytarish

Eski kabinet migratsiyasi sakkizta xususiy jadvalni kutadi. Avval xabar jo‘natishni to‘xtating va yuborilayotgan yoki o‘chirilishi kerak bo‘lgan Telegram xabarlarini yakunlang. `001_withdraw.sql` ochiq yetkazish/o‘chirish ishi topsa tranzaksiyani bekor qiladi. Tayyor bo‘lganda u trigger va servis huquqlarini yechadi, navbat va dublikatni to‘xtatuvchi holatlarni egasi o‘qiy oladigan `ua_private.teacher_notifications_v1_retained` jadvaliga ko‘chiradi. Keyin mavjud kabinetning `managed.mjs down` tartibi ishlatiladi. Qaytarish uchun avval kabinetni `managed.mjs restore` bilan tiklang, keyin `001_teacher_notifications.sql`ni bajaring. Shu o‘qituvchiga oldin yuborilgan xabar qayta yuborilmaydi.

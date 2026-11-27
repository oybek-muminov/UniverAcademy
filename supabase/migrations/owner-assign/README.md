# Ega o‘quvchini ustoz qiladi

Bu migratsiya Ega kabinetiga bitta yangi imkon beradi: ID bo‘yicha topilgan, ro‘yxatdan o‘tishni tugatgan va hech qanday guruhda bo‘lmagan o‘quvchini **fizika ustozi** qilish. Kabinet serveri (`ua_cabinet_stage`) hamon `people.roles` va `staff_access`ga **to‘g‘ridan-to‘g‘ri yoza olmaydi**. U faqat `ua_cabinet.owner_assign_teacher(actor, target, subject)` funksiyasini chaqiradi.

## Funksiya nimani tekshiradi

- chaqiruv tizimga kirgan Eganing o‘z tranzaksiyasida bo‘lishi (`ua.phase='domain'`, `ua.person_id` = Ega) va Ega o‘zini tayinlamasligi;
- Ega faol, roli aynan `owner` va `staff_access.approved`;
- fan hozircha faqat `physics`;
- o‘quvchi faol, roli aynan `student`, ro‘yxatdan o‘tishi tugagan, faol guruh a’zoligi yo‘q.

Hamma shart bajarilsa: rol `teacher` bo‘ladi (profil ham mos yangilanadi), `staff_access` (hech qanday qo‘shimcha vakolatsiz), fan tasdig‘i va fan doirasi yoziladi. Mavjud trigger o‘qituvchiga Telegramda bir martalik xabar navbatini o‘zi qo‘yadi. Ega rolini bu yo‘l bilan berib bo‘lmaydi.

Funksiya egasi `ua_owner`. Uning jadvallardagi huquqi faqat shu funksiya o‘zi yozgan, bitta odamni nomlovchi tranzaksiya sozlamalari bilan ochiladigan qoidalar orqali beriladi. Boshqa hech kim bu qoidalardan foydalana olmaydi.

## O‘rnatish va sinov

Avval `teacher-staging`, `teacher-notifications` va `single-role` o‘rnatilgan bo‘lishi shart. Boshqariladigan operator bir marta bajaradi, vaqtinchalik `ua_owner` huquqi oxirida qaytarib olinadi:

```sh
psql "$OPERATOR_DSN" -X -v ON_ERROR_STOP=1 -f supabase/migrations/owner-assign/001_up.sql
node --test tests/teacher-staging-pilot/owner-assign-native.test.mjs tests/teacher-staging-pilot/owner-assign-http.test.mjs
```

Funksiya o‘rnatilmaguncha Ega saytidagi "Ustoz qilish" tugmasi xato beradi, boshqa hech narsa buzilmaydi. Server kodini migratsiyadan **keyin** joylang.

## Orqaga qaytarish

`001_down.sql` faqat funksiya va qoidalarni olib tashlaydi. Allaqachon tayinlangan ustozlar o‘z rolida qoladi. Qaytarishdan oldin Ega saytidagi so‘rovlar tugashini kuting.

# Saqlangan qoralamani tahrirlash

Mavjud kabinet bazasiga `001_up.sql`ni yangi API va Ustoz saytini nashr qilishdan oldin bir marta qo‘llang. Buyruq PostgreSQL 17 boshqaruv operatorining vaqtincha olgan `ua_owner` vakolatini shu tranzaksiyada qaytaradi. Qoralamalar, savol IDlari va natijalar ko‘chirilmaydi.

`ua_cabinet_stage` kanonik `draft_questions`da o‘z qoralamasining savollarini almashtirish va `demos.title`ni yangilash huquqini oladi. RLS joriy o‘qituvchi, faollik, tasdiqlangan fan va qoralama holatini tekshiradi. Bitta demo bir nechta versiyaga ega bo‘lsa, uning umumiy nomi saqlanadi. Qoralama savollari va metama’lumotlarini o‘sha nom bilan tahrirlash mumkin.

Ortga qaytarishda avval yangi tahrirlash yo‘lini o‘chiring va faol tranzaksiyalar tugashini kuting. `001_down.sql` yangi vakolat va siyosatlarni olib tashlaydi, saqlangan ish bazada qoladi. To‘liq kabinetning `down`idan oldin ushbu faylni bajaring. Kabinetni to‘liq tiklashda avval kabinetning `restore`ini, keyin `001_up.sql`ni bajaring.

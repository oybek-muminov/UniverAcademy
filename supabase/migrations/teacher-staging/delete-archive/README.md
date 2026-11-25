# Guruh va testni o‘chirish / arxivlash

`001_up.sql`ni kabinet va qoralama tahriri o‘rnatilgandan keyin, yangi API va Ustoz saytini nashr qilishdan **oldin** bir marta qo‘llang. Ma’lumotlar ko‘chirilmaydi, mavjud jadvallar o‘zgarmaydi.

- Bo‘sh guruh (hech qachon test berilmagan) butunlay o‘chadi; a’zolari “guruhsiz” ro‘yxatiga qaytadi.
- Test berilgan guruh `archived` holatiga o‘tadi; natijalar saqlanadi, a’zolari chiqariladi.
- Hech qachon guruhga berilmagan test butunlay o‘chadi.
- Guruhga berilgan test `ua_cabinet.test_archive` ro‘yxatiga tushadi: natijalar va topshiriqlar saqlanadi, o‘qituvchi ro‘yxatida ko‘rinmaydi.
- Guruh a’zosi test ishlayotgan paytda guruhni o‘chirib bo‘lmaydi.

Ruxsatlar faqat `ua_cabinet_stage` roliga va faqat o‘qituvchining o‘z qatorlari uchun beriladi (`ua_cabinet.acting_teacher()`).

Ortga qaytarish: avval xizmat jarayonlarini to‘xtating, so‘ng `002_down.sql`, undan keyin `001_down.sql`. Arxivlangan testlar jadvali va natijalar saqlanadi.

`002_up.sql`: hech kim boshlamagan topshiriqlari bor guruh ham butunlay o‘chadi (bitta urinish bo‘lsa ham arxivlanadi). Avval `001_up.sql` qo‘llangan bo‘lishi kerak.

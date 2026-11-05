# UniverAcademy uchun ish qoidalari

## Repozitoriy va ruxsat

Bu loyiha reposi: https://github.com/oybek-muminov/UniverAcademy
Laboratoriya: https://github.com/oybek-muminov/lab_univeracademy

Yordamchi tadqiqot, manba arxivi, tajriba va agentlar bilan almashish materiallari laboratoriyada yuritiladi. Laboratoriyadagi erkinlik loyiha reposi, baza yoki providerlarga avtomatik ruxsat emas.

Har ikkala repoga - UniverAcademy va lab_univeracademy - har bir yuklashdan oldin foydalanuvchining aynan shu yuklash uchun alohida tasdig‘i olinadi. Bu foydalanuvchining 2026-11-05dagi keyingi aniq ko‘rsatmasi. Lokal tayyorlash, laboratoriyada erkin tajriba qilish, oldingi umumiy rozilik yoki agentning tavsiyasi yuklash tasdig‘i deb olinmaydi. Joriy topshiriq doirasidan tashqari migration, provider sozlamasi va deploy bajarilmaydi.

## Manba va holat

Avval [docs/source-status.md](docs/source-status.md) va [docs/api/README.md](docs/api/README.md) o‘qilsin. Master §0.7 va §22 joriy; eski Rasch/MAP overlaylari tarixiy.

API 0.2.7-statistical-bonus-review.1 hali PROVISIONAL / NOT ACCEPTED. Backend yagona API egasi. Iste’molchilar kontraktni o‘zicha o‘zgartirmaydi; konkret diff Backendga qaytariladi.

Yangi loyiha nomzodida backend yo‘li `supabase/functions/univeracademy-api/`. Bu lokal tuzilma nomi; mavjud integratsiya, texnik identifikator yoki URL uchun avtomatik migratsiya emas. Amaldagi integratsiyalar faqat alohida aniq ruxsat va moslik rejasiga ko‘ra o‘zgartiriladi. Mavjud ish ustidan taxmin bilan yangi parallel backend yozilmaydi.

## Boshlang‘ich yo‘nalish

Modulli monolit: yagona API, PostgreSQL, xususiy media; frontendlar biznes qoidalarini takrorlamaydi. O‘quvchi custom opaque sessiyasi staff Auth JWTsidan ajratilgan.

Birinchi fizika guruh testi ustuvor. Oddiy natija mustaqil; statistik bonus optional, Rasch keyingi bosqichda. 10 milliondan ortiq ro‘yxat va 10 minggacha bir vaqtdagi test — o‘sish maqsadi, isbotlangan sig‘im emas.

Agent vazifalari va o‘zgarish chegaralari: [docs/ownership.md](docs/ownership.md).


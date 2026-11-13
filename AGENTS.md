# UniverAcademy uchun ish qoidalari

## Repozitoriy va ruxsat

Bu loyiha reposi: https://github.com/oybek-muminov/UniverAcademy
Laboratoriya: https://github.com/oybek-muminov/lab_univeracademy

Yordamchi tadqiqot, manba arxivi, tajriba va agentlar bilan almashish materiallari laboratoriyada yuritiladi. Laboratoriyadagi erkinlik loyiha reposi, baza yoki providerlarga avtomatik ruxsat emas.

Har ikkala repoga - UniverAcademy va lab_univeracademy - har bir yuklashdan oldin foydalanuvchining aynan shu yuklash uchun alohida tasdig‘i olinadi. Bu foydalanuvchining 2026-11-05dagi keyingi aniq ko‘rsatmasi. Lokal tayyorlash, laboratoriyada erkin tajriba qilish, oldingi umumiy rozilik yoki agentning tavsiyasi yuklash tasdig‘i deb olinmaydi. Joriy topshiriq doirasidan tashqari migration, provider sozlamasi va deploy bajarilmaydi.

## Manba va holat

Avval [README.md](README.md) o‘qilsin. Joriy o‘quvchi kontrakti `contracts/telegram-return.openapi.json`; tarixiy kontraktlar test va generatsiya bog‘liqliklari uchun saqlanadi.

Backend yagona API egasi. Iste’molchilar kontraktni o‘zicha o‘zgartirmaydi; konkret diff Backendga qaytariladi.

Yangi loyiha nomzodida backend yo‘li `supabase/functions/univeracademy-api/`. Bu lokal tuzilma nomi; mavjud integratsiya, texnik identifikator yoki URL uchun avtomatik migratsiya emas. Amaldagi integratsiyalar faqat alohida aniq ruxsat va moslik rejasiga ko‘ra o‘zgartiriladi. Mavjud ish ustidan taxmin bilan yangi parallel backend yozilmaydi.

## Boshlang‘ich yo‘nalish

Modulli monolit: yagona API, PostgreSQL, xususiy media; frontendlar biznes qoidalarini takrorlamaydi. O‘quvchi custom opaque sessiyasi staff Auth JWTsidan ajratilgan.

Birinchi fizika guruh testi ustuvor. Oddiy natija mustaqil; statistik bonus optional, Rasch keyingi bosqichda. 10 milliondan ortiq ro‘yxat va 10 minggacha bir vaqtdagi test — o‘sish maqsadi, isbotlangan sig‘im emas.

## Muvofiqlashtirish

Boshqa mas’ul yo‘lidagi o‘zgarish avval muvofiqlashtiriladi. Backend va iste’molchilar bir xil kontrakt versiyasi/xeshini tekshiradi. Clientdagi rol ruxsat uchun authoritative emas. Hosting adapterlari biznes qoidalarini takrorlamaydi.

Offline test yoki build natijasi production tayyorligi deb ko‘rsatilmaydi. Lokal tekshiruvlar [README.md](README.md)da.


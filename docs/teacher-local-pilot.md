# O‘qituvchi kabinetini mahalliy ishga tushirish

O‘qituvchi savollarni kabinetda tuzadi, o‘z fanida guruh ochadi va unga darhol o‘quvchi qo‘shadi, testni nashr qilib guruhga tayinlaydi va natijani ko‘radi. Mashq uchun ikki o‘qituvchi va ikki sun’iy o‘quvchi ajratilgan. Server faqat shu kompyuterning loopback manzilida ishlaydi. Barcha hisoblar, yopiq rasmlar, testlar, guruhlar va natijalar jarayon xotirasida saqlanadi. Server qayta ishga tushsa mashq boshidan boshlanadi.

## Ishga tushirish

Node.js 24 va npm kerak. Repo ildizida quyidagilarni bajaring.

```sh
npm ci --ignore-scripts
npm run setup:validator
npm ci --prefix runtime/teacher-local-ui --ignore-scripts
npm run test:teacher-pilot
npm run start:teacher-pilot
```

Brauzerda **http://127.0.0.1:4178/** manzilini oching. Band portni o‘zgartirish uchun masalan `PORT=4180 npm run start:teacher-pilot` ishlatiladi. Mahalliy sahifalarni HTTPS domen, server IP yoki proksi orqali ochishga ruxsat berilmaydi. O‘qituvchi, Admin va o‘quvchi nomlari bilan mustaqil cookie saqlangani sababli ularni bir brauzerning alohida oynalarida ochish mumkin. Haqiqiy ro‘yxatdan o‘tish, Clerk siri, Telegram tokeni va Supabase paroli talab qilinmaydi.

## Boshidan oxirigacha mashq

1. **O‘qituvchi kabineti** sahifasida guruh nomini kiriting va **Guruh yaratish** tugmasini bosing. Yangi guruh darhol faol bo‘ladi.
2. Faol guruhda guruhsiz o‘quvchilar ro‘yxatidan **Aziza Karimova (0100000001)**ni tanlab guruhga qo‘shing. Qo‘shilgan o‘quvchi guruh a’zolari orasida ko‘rinadi. ID orqali qo‘shish ham mavjud. **0100000002** uchun **Bot orqali yuborish**ni sinang. Ikkinchi o‘quvchi mashq botini oldin boshlagan. Uning o‘quvchi kabinetida mahalliy xabar ko‘rinadi. U xabardagi havolani ochadi, botni boshlaydi, o‘z hisobini tanlaydi va guruhga kirishni tasdiqlaydi. Birinchi marta botga kiruvchi uchun o‘qituvchidagi havolani ulashish yo‘lini tanlang. Mashqdagi Telegram havolasi namuna, tashqi botga yuborish bajarilmaydi.
3. **Testlar** bo‘limida yangi test nomi va vaqtini kiriting. Savol matnini, kerakli formulani va rasmni alohida blok sifatida qo‘shing. To‘rtta javobni kiriting, to‘g‘ri javobni tanlang. Variantga ham formula yoki rasm qo‘shish mumkin. Har bir savolning o‘quvchi ko‘rinishini tekshiring. Qoralamani saqlang. Keyin davom ettirish uchun ro‘yxatdan qoralamani tanlab, **Qoralamani tahrirlash** tugmasini bosing. Tayyor testni nashr qiling va ikkala o‘quvchi a’zo bo‘lgan guruhga tayinlang. Yangi a’zo uchun huquqlar shu tayinlashda beriladi.
4. **O‘quvchi kabineti** oynasida tegishli hisobni tanlang. Testni boshlang, javobni saqlang, yangilangan sahifada shu tanlovni tekshiring va testni yakunlang. Variantlar har bir o‘quvchining urinishi boshlanganda aralashtiriladi. O‘quvchi qaytib kirsa, ularning tartibi saqlanadi. O‘qituvchi **Natijalar** sahifasini yangilab har bir ishtirokchining oddiy balli va foizini ko‘radi.
5. Qabulni tekshirish uchun boshqa o‘qituvchi bilan shu guruhga yozish, o‘quvchi rolida guruh yaratishga urinish, qayta taklif orqali o‘tish, o‘zga urinishdan rasmni ochish va muddati tugagan taklifni ishlatishni QA ssenariylari qamrab oladi. Vakolatlar sinovda ham har amalda qayta tekshiriladi.

## Matn, formula va rasm

Savol va variant `QuestionWrite` dagi tartiblangan bloklardan tuziladi. Matn `type: text, markdown`, formula `type: formula, latex, display` (`inline` yoki `block`), rasm `type: image, asset_id, alt` va ixtiyoriy `caption` orqali yoziladi. Eganing 2026-yil 20-noyabrdagi qaroriga ko‘ra o‘qituvchi LaTeX kodini kiritadi. Matematik ifoda masalan `\frac{s}{t}`. O‘qituvchi va o‘quvchi uchun bitta mahalliy KaTeX 0.19.1 kutubxonasi qo‘llanadi. Xato yoki qo‘llanmagan buyruq qoralama yozilishidan oldin qaysi savol/variant/blokda ekanini bildiradi. O‘quvchi ko‘rinishida renderer yuklanolmasa tushunarli xabar chiqadi. Kalit va o‘qituvchi uchun izoh o‘quvchining faol urinishiga uzatilmaydi. PNG uchun 2 MiB, SVG uchun 256 KiB, eng uzun tomon uchun 2048 piksel chegara belgilangan. PNG qayta kodlanadi. SVG geometriya, asosiy rang, oddiy matn hamda guruhdan iborat statik chizma bo‘lishi kerak. Tashqi rasm, uslub, filtr, animatsiya yoki faol elementli SVG uchun muharrirdan PNG eksport qiling. Server tasdiqlangan SVGni PNGga aylantirib, faqat yopiq PNGni tarqatadi.

**Qo‘shimcha fayl importi.** `apps/teacher-web/local-pilot/sample.txt` oddiy UTF-8 namuna. Birinchi qatorda `Nomi: ...`, ixtiyoriy `Vaqt (soniya): 300`, keyin har bir savol uchun tartib raqami va to‘rtta javob yoziladi. Uchta javob qatorini `- `, to‘g‘ri javobni `* ` bilan boshlang. Avvalgi A–D va `Javob: B` yozuvi ham qabul qilinadi. Parser xato qatorini ko‘rsatadi. `sample.json` to‘rt variantli matnli almashinuv namunasidir. TXT/JSON uchun HTTP so‘rovi chegarasi 512 KiB. Word, skanli PDF va rasmdan matn ajratish bu pilotda mavjud emas. Bunday materialni savolma-savol kiritib, kerakli formulasini yoki rasmini biriktirish mumkin.

## Qo‘shimcha tekshiruvlar

`npm run test:teacher-pilot` mahalliy HTTP va domenni tekshiradi. Montaj qilinadigan muharrir va haqiqiy KaTeX MathML ko‘rinishini DOM bilan takrorlash uchun `npm ci --prefix tests/teacher-local-pilot/tooling --ignore-scripts`, keyin `npm run test:teacher-pilot-dom` bajaring. Real brauzer sinovi uchun Chromium va Python Playwright o‘rnatilgan mashinada `PILOT_SCREENSHOTS=/tmp/univeracademy-pilot-screens python3 tests/teacher-local-pilot/browser.py` buyrug‘i alohida serverni vaqtincha ishga tushiradi. Standart Chromium yo‘li aniqlanmasa `CHROMIUM_PATH`ga brauzerning to‘liq yo‘lini bering. Skript 390 piksel kenglikda o‘quvchi ko‘rinishi, shakllangan kasrlar va rasmlarni tekshirib, muvaffaqiyatdan keyin haqiqiy brauzer suratlarini yozadi.

Ushbu tayyorlash muhitida Chromium ishga tushayotganda UNIX soketini ochish uchun ruxsat olmadi. DOM sinovi fizik ekran va haqiqiy mobil brauzerda ko‘rinishni tasdiqlamaydi.

## Kod va jonli pilot orasidagi bog‘lanish

- Mahalliy tarmoqdagi HTML va cookie `runtime/teacher-local-pilot.mjs`ga tegishli. Bu test identifikatsiyasi ishchi Clerk/Telegram autentifikatsiyasi bilan ulanmaydi. Oddiy `npm start` va ishlab chiqarish Worker’i bu marshrutlarni ochmaydi.
- Mavjud backendning savol va variant yozish, versiyani nashr qilish, guruhga egalik va ruxsat doirasi, imtihonning server vaqti, idempotensiya, javob reviziyasi va oddiy baholash qoidalari ishlatiladi. Rich media uchun ruxsat beruvchi server adapteri bo‘lmasa oldingi yo‘l yopiq qoladi. Mavjud o‘qituvchining faqat o‘qish uchun sahifasi o‘z yo‘lida ishlaydi.
- Jonli bosqichda Ega haqiqiy o‘qituvchini Supabase orqali tayinlaydi. Backend o‘qituvchi/admin yozish amallarini Clerk’ning haqiqiy va bekor qilinmagan sessiyasi, fan va guruh ruxsati bilan bog‘laydi. PostgreSQL’da qoralama va versiya, guruh va unga o‘qituvchining ruxsati, a’zolik, taklif, idempotensiya kvitansiyasi hamda xabar navbatini atomar saqlaydigan yozuv adapterlari va database ruxsatlari tekshiriladi. Xususiy media uchun saqlash, ruxsatni tekshirish va vaqtinchalik yuklab olish yo‘li haqiqiy omborgacha ulanadi.
- Telegram uchun botni oldindan boshlagan o‘quvchiga yetkazish, 429/qayta urinish, muddati va bekor qilinishi, shuningdek birinchi marta kiruvchining deep-link orqali identifikatsiyasi tasdiqlanadi. Mini App’da mavjud kirish yo‘li va shaxsiy sessiya ishlatiladi. Ustoz va o‘quvchi adapterlari ruxsatlar bilan deploymentga ulanganidan keyin haqiqiy bitta fizika guruhi bilan nazoratli qabul o‘tkaziladi. Yuklama sig‘imi bu mahalliy mashqda o‘lchanmaydi.

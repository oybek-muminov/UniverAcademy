# Ega: guruhni topshirish va ustoz vakolatini qaytarish

Bu bosqichda mahalliy kod faqat oldindan tekshiradi. API yo‘li va jonli kabinetga tugma ulanmagan; bazaga yozmaydi.

1. Ega faol guruh va qabul qiluvchi ustozni tanlaydi. Ustoz faol, tasdiqlangan va aynan shu fanga vakolatli bo‘lishi kerak. O‘z hisobini o‘chirishni so‘ragan, barcha guruh yoki barcha fan vakolati bor ustoz bu oqimda qabul qiluvchi bo‘lmaydi.
2. Guruhning bitta amaldagi mas’ul ustozga bog‘langanini tekshiramiz. Test ochiq yoki rejalangan bo‘lsa, yoxud o‘quvchi imtihonni hali topshirayotgan bo‘lsa, guruh ko‘chmaydi. Yaroqsiz vaqt yozuvlari xavfsizlik uchun bloklanadi.
3. Keyingi yozuvchi amal tasdiqlash oynasida guruh va ikkala ustozni ko‘rsatadi. Tranzaksiya eski ustoz va guruh versiyasi o‘zgarmaganini, ruxsat va test holatini yozishdan avval qayta tekshirishi shart. Ega tugmani ikki marta bosganda bitta amal va bitta audit yozuvi qoladi.
4. Guruh qatori va uning aniq vakolati bitta tranzaksiyada yangi ustozga o‘tadi. Guruh identifikatori, ro‘yxat, a’zolik turi, topshiriqlar va natijalar o‘zgarmaydi. Natijani ko‘rish guruhga ergashadi; mualliflik va test banki o‘tmaydi. Eski ustoz yaratgan taklif orqali yangi a’zo qo‘shilmasligi kerak; tarix o‘chirilmaydi.
5. Vakolatni qaytarish hisobni o‘chirish yoki o‘quvchi roliga o‘tkazish emas. Faol yoki tasdiq kutayotgan guruh bo‘lsa avval u hal qilinadi. Arxiv guruhlari va noaniq vakolatlar alohida ko‘rib chiqiladi, chunki jim to‘xtatish ularning tarixiga amaldagi kirishni olib qo‘yishi mumkin. Ega/admin yoki faol ustoz bo‘lmagan hisob bu yo‘lning nishoni bo‘la olmaydi.

## Jonli chiqarishdan avval

- Haqiqiy bazadagi cheklovlar, audit va o‘chirish himoyasi katalogdan faqat o‘qib tekshiriladi. Ishlayotgan DB roliga bevosita yozish vakolati berilmaydi.
- Yozuvchi amal uchun alohida ko‘rib chiqilgan migratsiya, parallel test boshlanishi va ustoz topshirig‘i bilan poyga sinovlari, takroriy so‘rov va tranzaksiya qaytishi sinovlari kerak. Guruhni va testni boshqa yozish yo‘llaridan ham shu tartib himoyalashi kerak.
- GitHub yuklashi, jonli baza migratsiyasi va reliz mustaqil qarorlar. O‘chirish so‘roviga qaror berish bu bosqich emas.

## Handover-4: guruh qatori bo‘yicha mahalliy sinov

Avvalgi Handover-3 sinovi xavfsizlik uchun butun jadvallarni qulflagan. Shu sababli o‘sha paytda boshqa guruh bilan bog‘liq yozuv ham kutishi yoki rad etilishi mumkin edi. Uni jonli tizimga ishlatmaymiz.

- `docs/owner-group-transfer-fence.review.sql` faqat sinov taklifi. Amaldagi guruh so‘rovi qatori, so‘ng guruhning asosiy qatori qulflanadi. Tegishli vakolat va taklif qatorlari ham tekshiriladi. Qulf band bo‘lsa, kutib qolmasdan amal rad etiladi. Role yoki bazaga yozish huquqi qo‘shilmaydi; ishlab turgan API va Ega kabinetiga ulanmagan.
- Mahalliy PostgreSQL sinovi cheklangan rol bilan ishlaydigan o‘qituvchi va o‘quvchi amallaridan foydalanadi. Bitta guruhdagi parallel topshiriq, urinish yoki fan bo‘yicha vakolat o‘zgarishi topshirishni bloklashi, boshqa guruhdagi amal esa davom etishi kerak. Topshirish oldin boshlansa, kutayotgan eski ustozning haqiqiy so‘rovi tasdiqlangandan keyin yana tekshirilishi va rad etilishi kerak. Tarixiy natija, a’zolik, topshiriq va test muallifi saqlanadi. Eski taklif bekor bo‘ladi va guruh qayta berilganda ham tiklanmaydi.
- Jonli chiqarishni to‘sadigan yo‘llar qolgan: eski o‘quvchi API-si ayrim urinishlarni guruh qulfiga kirmasdan yozadi. Shuningdek rejalashtirishga bevosita yozuvchi amallar, hisobni o‘chirish yoki tiklash va Telegram taklif yuborishga olingan paytdagi xatti-harakat alohida tekshiriladi. Yetkazib bo‘lingan eski havola a’zolikni qayta ochmasligi kerak; tashqi yuborishni orqaga qaytarish mumkin emas.
- Sinovdagi Ega amali faqat ajratilgan baza operatori orqali chaqiriladi. Bu amaldagi server roli uchun ruxsat borligini anglatmaydi. Jonli katalogdagi RLS, rol va ustun ruxsatlari, trigger va funksiya egasi tekshirilmaguncha yangi huquq ham, yozuvchi endpoint ham qo‘shilmaydi. Ega tugmasi faqat backend tasdiqlangan imkoniyatni ko‘rsatsa chiqadi.


# Staging guruh takliflari

O‘qituvchining shaxsiy taklifi bazaga navbat yozuvi sifatida tushadi. Telegramga yozishni oldin boshlagan, kabinetiga bog‘langan o‘quvchi uchun xabarga Mini App tugmasi qo‘shiladi. Tugma mavjud kirish jarayonini ochadi. Taklifni qabul qilish uchun o‘quvchi kabinetda tasdiqlaydi. Umumiy guruh havolasi ham ishlaydi: Telegram shaxsiy chatda `/start grp_…` orqali ayni kabinetga o‘tish tugmasini chiqaradi.

## Staging operatori uchun

- Mini App buildida `VITE_TEACHER_PILOT_ENABLED=true` tanlanganida guruh kabineti ro‘yxatdan o‘tgan, server tasdiqlagan Student sessiyasidan foydalanadi. `VITE_API_ORIGIN` avvaldan tekshirilgan yagona API manziliga ishora qiladi.
- API Worker uchun alohida `TelegramPilotDirectory` nomli xususiy kirish nuqtasi, `UA_TELEGRAM_PILOT_DIRECTORY_ENABLED=true` va `TEACHER_PILOT_HYPERDRIVE` kerak. Unga faqat staging shaxsiy chat qaydini yozish uchun zarur DB huquqlarini bering. Bot Worker `TELEGRAM_PILOT_DIRECTORY` service binding orqali shu nuqtani chaqiradi. Amaldagi `TELEGRAM_START_LOOKUP` o‘z o‘quvchi holati tekshiruvini bajaradi.
- Botda `TELEGRAM_TEACHER_PILOT_ENABLED=true` hamda tekshirilgan `MINI_CABINET_URL` (https origin va `/`) va `MINI_SIGN_IN_URL` (shu origin va `/sign-in`) ishlatiladi. Telegram webhook siri avvalgi tartibda tekshiriladi. Faol staging sozlamalari bilan olingan haqiqiy shaxsiy `/start` chat qaydini yangilaydi. Eski bog‘lanishning o‘zi chatni boshlangan deb hisoblash uchun yetarli emas.
- Navbatdagi bitta xabarni yuborish uchun operator tanlagan ishga tushirish muhitida `TELEGRAM_TEACHER_PILOT_DELIVERY_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `MINI_CABINET_URL`, `MINI_SIGN_IN_URL` va `TEACHER_PILOT_DATABASE_URL` kerak. DB URL aniq staging roli, host va baza nomini oladi. TLS sertifikati tekshiriladi. Kerakli CA operator muhitida ishonchli bo‘lishi lozim. Chaqirish buyrug‘i `node runtime/staging-invite-dispatch-job.mjs`.
- `sent` Telegram javobidagi chat va xabar raqami tasdiqlanganini anglatadi. `retry` Telegram belgilagan kutish vaqtidan keyin navbatga qaytadi. `unconfirmed` yoki yuborish orasida uzilish yuz bersa, o‘sha xabarni qo‘lda tekshiring. Qabul qilingan bo‘lishi mumkin bo‘lgan xabar avtomatik takrorlanmaydi. `rejected` bo‘lsa, bot bloklanganini yoki chatga yuborish mumkinligini tekshiring. `empty` tayyor xabar yo‘qligini bildiradi.

Bayroqlar odatda o‘chiq. Jadval va provider sozlamalarini staging egasi alohida tanlaydi.

## API Worker orqali avtomatik yuborish

1. Tasdiqlangan bazada `ua_cabinet.private_starts`, `ua_cabinet.invites`, `ua_cabinet.invite_delivery` va `ua_cabinet_delivery` roli mavjudligini tekshiring. API Worker’dagi alohida `TEACHER_PILOT_HYPERDRIVE` shu bazaga ulanadi. Uning loginiga `SET ROLE ua_cabinet_delivery` huquqi kerak. Hyperdrive’da bazagacha TLS tekshiruvini yoqing va so‘rov keshini o‘chiring.
2. Yuqoridagi private-start binding va bayroqlarni ulang. O‘quvchi o‘z Telegramini kabinetiga bog‘laydi va botdagi shaxsiy chatda `/start` yuboradi. O‘qituvchining `sendInvite` javobidagi `queued` shu o‘quvchi uchun taklif navbatga tushganini bildiradi.
3. API Worker’da `UA_CABINET_STUDENT_ORIGIN`ni tasdiqlangan Mini App originiga o‘rnating. Shu origin `UA_ALLOWED_ORIGINS` ro‘yxatida bo‘lishi kerak. Operator avtomatik yuborishga ruxsat bergach, `UA_TELEGRAM_PILOT_DISPATCH_ENABLED=true`ni yoqadi. Handler xabar jo‘natish uchun shu API Worker’dagi mavjud `UA_TELEGRAM_BOT_TOKEN` siridan foydalanadi.
4. API Worker’ning `scheduled` handleriga egasi tanlagan Cron Trigger’ni ulang. Har chaqiruv navbatdagi bitta tayyor taklifni qayta ishlaydi. Masalan, har daqiqalik jadval bir daqiqada bitta taklifni yuborishga urinadi. Birinchi yuborishda navbat yozuvi `sent`ga o‘tganini va o‘quvchi bot xabaridagi tugma orqali o‘z kabinetida taklifni qabul qilganini tekshiring.

`retry` yozuvlari Telegram belgilagan vaqtdan keyin qayta olinadi. `claimed` holatida qolgan yoki `unconfirmed` yozuv uchun operator Telegramdagi natijani tekshiradi. Avtomatik yuborishni to‘xtatish uchun API Worker’da dispatch bayrog‘ini o‘chiring va unga biriktirilgan Cron Trigger’ni olib tashlang.

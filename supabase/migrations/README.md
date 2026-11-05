# Baza o‘zgarishlari

Mas’ul: Backend. QA isolation, rollback va data-preservation tekshiruvlarini ko‘radi.

Hozir SQL migration yaratilmagan va baza o‘zgartirilmagan. Avval amaldagi schema/RLS/index/constraint/precision/scale inventari olinadi. Hujjatdagi konseptual jadval real SQL deb ko‘chirilmaydi.

Keyingi taklifda aniq schema diffi, mavjud ma’lumotga ta’sir, backfill zarurati, sinov va rollback/recovery rejasi ko‘rsatiladi. Yangi migration yoki providerga tatbiq etish aniq ruxsat doirasida bajariladi.

Haqiqiy o‘quvchi ro‘yxati, test javob kaliti va secretlar seed yoki public repo fayliga yozilmaydi.


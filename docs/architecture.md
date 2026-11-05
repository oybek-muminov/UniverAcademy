# Boshlang‘ich arxitektura

Holat: ma’qul ko‘rilgan yo‘nalishning boshlang‘ich hujjati. API va aniq implementatsiya tafsilotlari alohida review qilinadi; sig‘im yoki tayyor deploy da’vosi yo‘q.

## Tizim

O‘quvchi → Telegram Mini App → yagona API → Supabase PostgreSQL va xususiy fayllar.
Ega/Admin/O‘qituvchi → brauzer paneli → o‘sha API.
Landing o‘z statik frontendidir.

Backend modulli monolit sifatida rivojlanadi. Yangi lokal nomzod backend yo‘li `supabase/functions/univeracademy-api/`; bu provider yoki ishlayotgan funksiyani qayta nomlash amali emas. Alohida `backend/` daraxti boshlang‘ich shart emas. React/TypeScript va mavjud Supabase/Edge Functions yo‘nalishi inventar bilan tekshiriladi.

Taklif etiladigan ichki modul chegaralari: identity/auth, roles/scope, groups/roster, demos/versions/media, assignments/admission, attempts/answers/recovery, ordinary/bonus, results/review/export, notifications. Bu ro‘yxat hozircha yangi kod fayllari yoki SQL sxemasi emas.

## Muhim chegaralar

- O‘quvchi custom opaque sessiyasi staff Supabase Auth JWTsidan ajratiladi.
- Vaqt, current generation, saqlangan javoblar va natija server tomonidan boshqariladi.
- Javob CAS revision bilan saqlanadi; konfliktda client qayta o‘qib muvofiqlashtiradi. Tasdiqlangan javob doimiy saqlanmasdan muvaffaqiyat deyilmaydi.
- Publish qilingan kontent va attemptga bog‘langan tartib/versiya barqaror; to‘g‘ri kalit clientga erta berilmaydi.
- Oddiy natija bonusni kutmaydi. Bonus ordinary natija yoki foizni o‘zgartirmaydi.
- Bonusning kichik pilot uchun texnik taklifi sinxron, atomik, bir martalik snapshotdir. Alohida worker yoki queue uning boshlang‘ich sharti emas.
- Bildirishnomalar asosiy test tranzaksiyasini ushlab turmaydi; mavjud outbox/dispatcher kodi inventarda tekshiriladi. Aniq bajaruvchi va konfiguratsiya konkret reja bilan kelishiladi.
- Biznes qoidalari frontendlar va hosting adapterlari orasida nusxalanmaydi.

## O‘sish

Maqsad: 10 milliondan ortiq ro‘yxatdan o‘tgan foydalanuvchi va platforma bo‘yicha 10 minggacha bir vaqtdagi test. Bu bitta guruhda 10 ming ishtirokchi borligini anglatmaydi. Eng katta guruh/cohort hajmi alohida o‘lchanadi.

Avval indekslar, qisqa tranzaksiyalar, pagination, ulanishlar havzasi va kuzatuv; keyin o‘lchovga qarab API nusxalari, fon ishlarini ajratish, o‘qish replikalari yoki jadval bo‘limlash. Mikroxizmat/sharding/Kubernetes boshlang‘ich shart emas.

667 save/soniya — faqat 10 ming ishtirokchi har 15 soniyada bitta save yuboradi degan misol. Bu APIga yangi interval yoki batching qo‘shish qarori emas. Client CAS oqimi, real javob almashishi, start/submit cho‘qqisi va rasm trafigi bilan o‘lchanadi.

O‘qish replikasidagi kechikish authorization va read-after-write oqimini buzmasligi kerak. Birinchi 10–30 kishilik pilotga katta platformaning barcha infratuzilmasi majburiy qilinmaydi.

## Ochiq texnik bandlar

Mavjud kod/baza inventari, API owner reviewi, decimal/rational policy va DB chegaralari; delegated Admin scope; bot identity/provider va session/notification/media/polling/rate-limit sozlamalarining pilot uchun kerakli qismi; haqiqiy yuklama va tiklash talablari. Oldin tasdiqlangan mahsulot qoidalari yangidan tanlanmaydi.

## Tadqiqot manbalari

- Moodle: https://docs.moodle.org/dev/Moodle_architecture
- Open edX: https://docs.openedx.org/en/latest/developers/references/developer_guide/architecture.html
- OpenOlat: https://github.com/OpenOLAT/OpenOLAT/blob/master/doc/openolat-architecture.html
- Telegram: https://core.telegram.org/bots/webapps
- Supabase ulanishlar: https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits

Bu manbalar arxitektura naqshlari uchun dalil, UniverAcademy sig‘imi uchun benchmark emas.


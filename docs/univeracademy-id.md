# UniverAcademy ID

Ekranda **UniverAcademy ID**, joy kam bo‘lsa **ID** yoziladi. O‘quvchi raqami avvalgidek o‘n raqamli matn, masalan `0100000001`. Raqamning o‘zi, ichki shaxs UUIDsi, mavjud guruh a’zoligi va natijalar tarixi saqlanadi.

## API mijozlari

| Mijoz so‘rovi | Profil yoki sessiya javobi |
| --- | --- |
| `Accept: application/json; profile=univeracademy-id-v2` | `univeracademy_id` |
| Oldingi klientning `Accept: application/json` so‘rovi yoki `Accept` berilmagan so‘rov | Oldingi klient kutgan `qadam_id` |

Yangi mijozlar jadvaldagi aniq `Accept` qiymatini yuboradi. Har javobda bitta ID maydoni qaytadi. Bu qoida `GET/PATCH /me` va profil qaytaradigan barcha kirish va sessiya yangilash yo‘llariga, jumladan Telegram orqali kirishga tegishli. Mijoz IDni profilni tahrirlash so‘rovida yubormaydi. Yangi sxema nomi `UniverAcademyId`. XLSX kontraktida `X-UniverAcademy-Snapshot-At` hisobot holatining vaqti, `X-UniverAcademy-Report-Revision` hisobot reviziyasidir. Ushbu repodagi XLSX qismi kontrakt darajasida.

## Chiqarish ketma-ketligi

1. [Baza migratsiyasi](../supabase/migrations/cabinet-id/README.md)ning `expand` bosqichini bajaring. Eski server shu bosqichdan keyin ham mavjud hisobni o‘qishi va yangi o‘quvchini ro‘yxatdan o‘tkazishi kerak.
2. Yangi API versiyasini barcha faol server nusxalariga chiqaring. Yangi frontendni chiqarishdan oldin bitta test hisobida jadvaldagi ikkala so‘rov o‘sha IDni qaytarishini tekshiring.
3. Yangi Mini App va boshqa yangilangan mijozlarni tarqating. Eski ochiq veb-sahifalar va saqlangan mijozlar avvalgi javob shaklidan foydalanishda davom etadi.
4. Eski server nusxalari xizmatdan chiqqach, bazada `forward`, keyin `backfill` bosqichlarini bajaring. Oldingi klientlarni qo‘llash uchun serverdagi javob mosligi saqlanadi.

Frontendni qaytarishda API ikkala ko‘rinishga ham xizmat qiladi. Serverning eski versiyasiga qaytish uchun avval eski frontendni tarqating va yangi `Accept` bilan ochiq qolgan mijozlar uchun mos API versiyasini saqlang. Baza yakunlovchi bosqichdan o‘tgan bo‘lsa, eski server trafik olishidan oldin bazada `rollback`, keyin `backfill` bosqichlarini bajaring.

## Tarixiy manbalar

Oldingi kontrakt, asl manbalar nomi va xeshi, real muhitdan olingan schema kataloglari, muayyan commitga bog‘langan tekshiruv arxivi asl yozilishini saqlaydi. Amaldagi kontrakt `contracts/telegram-return.openapi.json`; undagi tarixiy manba qaydlari kontraktning faol yo‘llari va sxemalaridan alohida.

Tashrif sahifasidagi zinapoya tasvirini tayyorlash uchun berilgan manba nomi `qadam-animatsiya.html` bo‘lgan. Eski yozuvli ikonka asl commitda `apps/landing/public/brand/qadam-staircase-book.png`, Git blob `04133ca4a74effce0a2976e268f8923db7a82413` sifatida saqlangan. [Avvalgi nusxa](https://github.com/oybek-muminov/UniverAcademy/tree/d62adb0f090b3e964450163d6607387c248d56bc/apps/landing)

# UniverAcademy ID

Ekranda **UniverAcademy ID**, joy kam bo‘lsa **ID** yoziladi. O‘quvchi raqami avvalgidek o‘n raqamli matn, masalan `0100000001`. Raqamning o‘zi, ichki shaxs UUIDsi, mavjud guruh a’zoligi va natijalar tarixi saqlanadi.

## API mijozlari

| Mijoz so‘rovi | Profil yoki sessiya javobi |
| --- | --- |
| `Accept: application/json; profile=univeracademy-id-v2` | `univeracademy_id` |
| Oldingi klientning `Accept: application/json` so‘rovi yoki `Accept` berilmagan so‘rov | Oldingi klient kutgan `qadam_id` |

Yangi mijozlar jadvaldagi aniq `Accept` qiymatini yuboradi. Har javobda bitta ID maydoni qaytadi. Bu qoida `GET/PATCH /me` va profil qaytaradigan barcha kirish va sessiya yangilash yo‘llariga, jumladan Telegram orqali kirishga tegishli. Mijoz IDni profilni tahrirlash so‘rovida yubormaydi. Yangi sxema nomi `UniverAcademyId`. XLSX kontraktida `X-UniverAcademy-Snapshot-At` hisobot holatining vaqti, `X-UniverAcademy-Report-Revision` hisobot reviziyasidir. Ushbu repodagi XLSX qismi kontrakt darajasida.

## Chiqarish ketma-ketligi

1. Yangi registration API versiyasini chiqarish mumkin. U dastlabki PostgreSQL sxemasida ham yangi o‘quvchi yaratadi va profil ismini yangilaydi. API chiqarilishi Supabase ustunining nomini o‘zgartirmaydi. Yangi frontendni chiqarishdan oldin jadvaldagi ikkala so‘rov o‘sha IDni qaytarishini tekshiring.
2. Yangi Mini App va boshqa yangilangan mijozlarni tarqating. Avvalroq ochilgan ilovalar eski javob shaklini olishda davom etadi.
3. Baza egasi jismoniy nomni almashtirishga ruxsat bergach, [ID migratsiyasidagi](../supabase/migrations/cabinet-id/README.md) tiklash nuqtasi va katalog tekshiruvlarini bajaring. `expand` yangi ko‘rinishni ochadi. U allaqachon bajarilgan bo‘lsa ham API shu sxemani taniydi. O‘qituvchi kabinetining PostgreSQL migratsiyasi shu ko‘rinishga tayanadi.
4. Eski server nusxalari xizmatdan chiqib, ularning tranzaksiyalari tugagach, `forward` orqali ustun nomini almashtiring. So‘ng `backfill` eski profil JSONlarini yangilaydi. Oraliqda har ikkala ko‘rinish o‘qiladi. Ro‘yxatga olish, ismni yangilash va boshidagi nollar `node --test tests/telegram-entry/native-registration-phases.test.mjs` orqali uchala bosqichda sinaladi.

Frontendni qaytarishda API ikkala ko‘rinishga ham xizmat qiladi. Serverning eski versiyasiga qaytish uchun avval eski frontendni tarqating va yangi `Accept` bilan ochiq qolgan mijozlar uchun mos API versiyasini saqlang. Baza yakunlovchi bosqichdan o‘tgan bo‘lsa, eski server trafik olishidan oldin bazada `rollback`, keyin `backfill` bosqichlarini bajaring.

## Tarixiy manbalar

Oldingi kontrakt, asl manbalar nomi va xeshi, real muhitdan olingan schema kataloglari, muayyan commitga bog‘langan tekshiruv arxivi asl yozilishini saqlaydi. Amaldagi kontrakt `contracts/telegram-return.openapi.json`; undagi tarixiy manba qaydlari kontraktning faol yo‘llari va sxemalaridan alohida.

Tashrif sahifasidagi zinapoya tasvirini tayyorlash uchun berilgan manba nomi `qadam-animatsiya.html` bo‘lgan. Eski yozuvli ikonka asl commitda `apps/landing/public/brand/qadam-staircase-book.png`, Git blob `04133ca4a74effce0a2976e268f8923db7a82413` sifatida saqlangan. [Avvalgi nusxa](https://github.com/oybek-muminov/UniverAcademy/tree/d62adb0f090b3e964450163d6607387c248d56bc/apps/landing)

# Ega kabineti (ega.univeracademy.uz)

Ega kabineti ustoz kabinetidan butunlay **alohida sayt**: o'z manzili, o'z kodi, o'z server eshigi. Ustoz sayti (`ustoz.univeracademy.uz`) Egani endi olib yurmaydi.

## Tuzilma
| Qism | Joyi |
|---|---|
| Sayt (brauzer sahifasi) | `apps/mini-app/owner-entrance/` (Vite, `dist-owner-entrance`) |
| Cloudflare Pages loyihasi | `apps/owner-web/ega-pages/` (nomi: `univeracademy-ega`) |
| Pages ichidagi yo'llar | `/api/v1/owner/pilot/dashboard` (o'qish) va `/api/v1/owner/pilot/commands/findStudent`, `.../assignTeacher` (faqat shu ikki buyruq) |
| Server eshigi | `OwnerCabinetGateway` (`runtime/cloudflare-worker.mjs`) → `fetchNativeCabinet(..., 'owner')` |
| Ruxsat | faqat `ega` roli + tasdiqlangan `staff_access`, har so'rovda bazadan tekshiriladi |
| Kirish | Clerk email-kod (mavjud hisob; Google bilan kirgan pochta ham bo'ladi). Yangi hisob ochilmaydi. |

Ega tokenining `azp` qiymati faqat `https://ega.univeracademy.uz` bo'lishi kerak. Ustoz saytining tokeni Ega yo'lida rad etiladi, Ega tokeni ustoz yo'llarida rad etiladi.

## Sozlamalar (Cloudflare)
1. **Pages loyihasi `univeracademy-ega`** (yangi): GitHub `oybek-muminov/UniverAcademy`, `main` shoxi. Quyidagi qurilish buyruqlari:
   - Root directory: `apps/owner-web/ega-pages`
   - Build command: `npm ci --prefix ../../mini-app --ignore-scripts --no-audit --no-fund && npm run build:assets && cp -R ../../mini-app/dist-owner-entrance dist`
   - Build output directory: `dist`
   - Custom domain: `ega.univeracademy.uz`
   - Build o'zgaruvchilari: `VITE_EGA_CLERK_PUBLISHABLE_KEY` (ustozdagi bilan bir xil `pk_live_...`), `VITE_EGA_EXISTING_EMAIL_SIGNIN_APPROVED=true`, `VITE_EGA_CABINET_ENABLED=true`.
   - Ish o'zgaruvchilari (Settings → Variables): `UA_CABINET_STAGING_ENABLED=true`, `UA_CABINET_RUNTIME=worker`, `UA_CABINET_OWNER_ORIGIN=https://ega.univeracademy.uz`.
   - Service binding: nomi `UA_CABINET_API` → Worker `univeracademy-api`, entrypoint **`OwnerCabinetGateway`** (`TeacherCabinetGateway` emas).
2. **`univeracademy-api` Worker**: `UA_CABINET_OWNER_ORIGIN=https://ega.univeracademy.uz`.
3. Tekshirish: sahifa ochiladi, email kodi bilan kirish, ega hisobi ismini ko'rsatadi. Ega roli bo'lmagan hisob "Bu kabinet faqat Ega uchun" ko'radi.

## O'qituvchi tayinlash
Ega sahifada o'quvchining 10 xonali UniverAcademy ID raqamini yozadi, "Topish" bosadi, ism chiqadi, "Ustoz qilish" va yana bir marta "Ha, ustoz qilish" bosadi. Natijada o'quvchi fizika ustozi bo'ladi va unga Telegramda xabar boradi. Hamma qaror serverda va bazada qabul qilinadi (`supabase/migrations/owner-assign/`):
- Faqat tugallangan, guruhda bo'lmagan o'quvchi ustoz bo'la oladi. Xodimni (ustoz/admin/ega) bu yo'l bilan o'zgartirib bo'lmaydi.
- Ega o'zini tayinlay olmaydi. Fan hozircha faqat fizika. Ustozga qo'shimcha vakolat (hamma guruh, hamma fan) berilmaydi.
- Bir xil so'rov ikki marta kelsa, ikkinchi marta hech narsa qo'shilmaydi. Har tayinlash jurnalga yoziladi.
- Migratsiya o'rnatilmaguncha tugma xato beradi, boshqa hech narsa buzilmaydi. Tartib: avval migratsiya, keyin server kodi.

## Keyingi bosqichlar (rejada)
Umumiy ko'rinish kengaytmasi, o'chirish so'rovlari ("Tasdiqlash" / "Rad etish"), ustozni qaytarish. Rol o'zgarishlari bitta jurnalli server funksiyasi orqali o'tadi, shunda keyinchalik "adminlar ovozi bilan Egani almashtirish" qoidasi faqat bir joyga qo'shiladi. Bazada "kamida bitta Ega doim bo'lishi" qoidasi kerak bo'ladi.

### Umumiy holat (lokal kengaytma)

Eganing mavjud dashboard so'rovi qo'shimcha ravishda faol, tasdiqlangan ustozlar; ro'yxatdan o'tgan faol o'quvchilar; faol guruhlar; hozir ochiq topshiriqlar; oxirgi 7 kun ichida topshirilgan urinishlar; tasdiq kutayotgan guruhlar; ochiq yoki rejalangan topshirig'i yo'q faol guruhlar sonini qaytaradi. Bu hisoblarda shaxsiy ma'lumot yoki test javoblari yo'q. Qiymat yo'q bo'lsa, eski javob uchun blok ko'rsatilmaydi; haqiqiy nol alohida ko'rinadi.

Tayinlash tugmasi faqat server bazadagi tayinlash funksiyasi mavjud va uni chaqirish vakolati borligini tasdiqlaganda ochiladi. Funksiya mavjud bo'lmasa ham ID bo'yicha qidirish ishlashi mumkin. Tasdiqlash paytida ID o'zgarsa, avvalgi tanlov bekor bo'ladi. Jonli migratsiya va chiqarish alohida tasdiqlanadi.

«Ustozlar»da faqat tasdiqlangan doira bo'yicha faol guruhlar soni va oxirgi 12 ta tayinlash qaydi bor. «Hisobni o'chirish so'rovlari»da ustozning oxirgi qayd etilgan so'rovi ko'rinadi; bu bajarilgan yoki tasdiqlangan degani emas. Ega uchun tozalash, tasdiqlash yoki rad etish tugmasi yo'q.

Keyingi yozuv amallari alohida: avval guruhni va test javobgarligini yangi ustozga topshirish (tasdiqlangan fan, faol imtihon qolmagan, o'quvchi ID va natijalari saqlanadi), keyin eski vakolatni qaytarish. O'chirish bo'yicha qaror faqat kimga nima o'tishi, qanday tarix saqlanishi va qaytarish yo'li belgilanganidan keyin. Ega vorisligi bu relizga kirmaydi.

# Ega kabineti (ega.univeracademy.uz)

Ega kabineti ustoz kabinetidan butunlay **alohida sayt**: o'z manzili, o'z kodi, o'z server eshigi. Ustoz sayti (`ustoz.univeracademy.uz`) Egani endi olib yurmaydi.

## Tuzilma
| Qism | Joyi |
|---|---|
| Sayt (brauzer sahifasi) | `apps/mini-app/owner-entrance/` (Vite, `dist-owner-entrance`) |
| Cloudflare Pages loyihasi | `apps/owner-web/ega-pages/` (nomi: `univeracademy-ega`) |
| Pages ichidagi yo'l | `/api/v1/owner/pilot/dashboard` (faqat shu o'qish) |
| Server eshigi | `OwnerCabinetGateway` (`runtime/cloudflare-worker.mjs`) → `fetchNativeCabinet(..., 'owner')` |
| Ruxsat | faqat `ega` roli + tasdiqlangan `staff_access`, har so'rovda bazadan tekshiriladi |
| Kirish | Clerk email-kod (mavjud hisob; Google bilan kirgan pochta ham bo'ladi). Yangi hisob ochilmaydi. |

Ega tokenining `azp` qiymati faqat `https://ega.univeracademy.uz` bo'lishi kerak. Ustoz saytining tokeni Ega yo'lida rad etiladi, Ega tokeni ustoz yo'llarida rad etiladi.

## Sozlamalar (Cloudflare)
1. **Pages loyihasi `univeracademy-ega`** (yangi): GitHub `oybek-muminov/UniverAcademy`, `main` shoxi. Quyidagi qurilish buyruqlari:
   - Root directory: `/`
   - Build command: `npm ci --ignore-scripts --prefix apps/mini-app && npm ci --prefix apps/owner-web/ega-pages && npm --prefix apps/owner-web/ega-pages run build`
   - Build output directory: `apps/mini-app/dist-owner-entrance`
   - Custom domain: `ega.univeracademy.uz`
   - Build o'zgaruvchilari: `VITE_EGA_CLERK_PUBLISHABLE_KEY` (ustozdagi bilan bir xil `pk_live_...`), `VITE_EGA_EXISTING_EMAIL_SIGNIN_APPROVED=true`, `VITE_EGA_CABINET_ENABLED=true`.
   - Ish o'zgaruvchilari (Settings → Variables): `UA_CABINET_STAGING_ENABLED=true`, `UA_CABINET_RUNTIME=worker`, `UA_CABINET_OWNER_ORIGIN=https://ega.univeracademy.uz`.
   - Service binding: nomi `UA_CABINET_API` → Worker `univeracademy-api`, entrypoint **`OwnerCabinetGateway`** (`TeacherCabinetGateway` emas).
2. **`univeracademy-api` Worker**: `UA_CABINET_OWNER_ORIGIN=https://ega.univeracademy.uz`.
3. Tekshirish: sahifa ochiladi, email kodi bilan kirish, ega hisobi ismini ko'rsatadi. Ega roli bo'lmagan hisob "Bu kabinet faqat Ega uchun" ko'radi.

## Keyingi bosqichlar (rejada)
Umumiy ko'rinish, o'chirish so'rovlari ("Tasdiqlash" / "Rad etish"), o'qituvchi tayinlash. Rol o'zgarishlari bitta jurnalli server funksiyasi orqali o'tadi, shunda keyinchalik "adminlar ovozi bilan Egani almashtirish" qoidasi faqat bir joyga qo'shiladi. Bazada "kamida bitta Ega doim bo'lishi" qoidasi kerak bo'ladi.

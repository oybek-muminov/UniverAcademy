# "Bitta odam — bitta rol"

Har bir odam bazada faqat **bitta** rolga ega bo‘ladi. Ustoz, admin yoki ega roli berilgan odamdan `student` roli o‘zi olib tashlanadi.

- `001_single_role.sql` — qoidani o‘rnatadi (bitta tranzaksiya, xato bo‘lsa hech narsa o‘zgarmaydi):
  - `ua_private.people` jadvaliga `single_role_normalize` triggeri: xodim roli bor bo‘lsa `student` olib tashlanadi va `profile.roles` moslanadi; ikki xodim roli rad etiladi (`SINGLE_ROLE_VIOLATION`);
  - `people_single_role` cheklovi: rollar ro‘yxati aynan bitta element;
  - mavjud qatorlarni qoidaga keltiradi (xodimdan `student` olib tashlanadi). Ikki xodim roli topilsa, ish to‘xtaydi va qo‘lda hal qilinadi;
  - Telegram `/start` qidiruvi (`lookup_telegram_start`) xodimni ham "bog‘langan" deb hisoblaydi, aks holda `student`siz ustozga bot hech narsa ko‘rsatmas edi.
- `001_withdraw.sql` — qoidani, cheklovni va yangi qidiruvni qaytaradi. Olib tashlangan `student` roli qaytarilmaydi.

Operator `ua_owner`, `ua_access_locator_owner` va `ua_deletion_executor` rollariga faqat tranzaksiya ichida vaqtincha o‘tadi; huquqlar oxirida qaytariladi va avvalgi holat bilan solishtiriladi.

```sh
psql "$OPERATOR_DSN" -X -v ON_ERROR_STOP=1 -f supabase/migrations/single-role/001_single_role.sql
node --test supabase/migrations/single-role/native.test.mjs
```

Kod tomoni: ustoz kabineti (`runtime/teacher-staging-store.mjs`) va xodim vakolatini o‘qish (`staff-access-rows.ts`) bir nechta roli bor odamga hech qanday vakolat bermaydi.

Ma’lum oqibat: faqat xodim roli bor odam o‘quvchi seansini ola olmaydi (`/auth/clerk` va `/auth/telegram/resume` `FORBIDDEN` qaytaradi). Ustoz kabineti brauzerda, ustoz botdan esa brauzer tugmasini oladi.

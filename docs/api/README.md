# API manbasi va review

Joriy draft: **0.2.7-statistical-bonus-review.1 — PROVISIONAL / NOT ACCEPTED**.
API egasi: Backend. Oldingi versiya qabuli yangi nusxaga meros bo‘lmaydi.

## Pinned manbalar

- [Markdown kontrakt](https://github.com/oybek-muminov/lab_univeracademy/blob/f2c580508cfec9e07f383610201af28edffd854b/UniverAcademy-statistical-bonus-review-2026-11-05/UNIVERACADEMY-API-CONTRACT-0.2.7-statistical-bonus-review.1.md)
- [To‘liq OpenAPI JSON](https://github.com/oybek-muminov/lab_univeracademy/blob/f2c580508cfec9e07f383610201af28edffd854b/UniverAcademy-statistical-bonus-review-2026-11-05/openapi-UniverAcademy-0.2.7-statistical-bonus-review.1.json)
- [Sonli hisoblash tavsiyasi](https://github.com/oybek-muminov/lab_univeracademy/blob/f2c580508cfec9e07f383610201af28edffd854b/UniverAcademy-statistical-bonus-review-2026-11-05/NUMERIC_POLICY_RECOMMENDATION.md)
- [Backend rejasi](https://github.com/oybek-muminov/lab_univeracademy/blob/f2c580508cfec9e07f383610201af28edffd854b/UniverAcademy-statistical-bonus-review-2026-11-05/BACKEND_IMPLEMENTATION_PLAN.md)
- [QA mezonlari](https://github.com/oybek-muminov/lab_univeracademy/blob/f2c580508cfec9e07f383610201af28edffd854b/UniverAcademy-statistical-bonus-review-2026-11-05/QA_ACCEPTANCE_MATRIX.md)

Dastlab bu indeks yoziladi; review paketining barcha arxivi va tarixiy JSON/diff nusxalari loyiha reposiga ko‘chirilmaydi. Backend reviewidan so‘ng kelishilgan kontraktni shu papkada yuritish uchun aniq fayl diffi va provenance taqdim etiladi. Hozir generated API client yoki yakuniy kontrakt fayli yaratilmaydi.

## Moslik talablari

StudentSession opaque, StaffJWT staff Auth uchun; biri ikkinchisining o‘rniga qabul qilinmaydi. Telegram initData tekshiruvi va consumed replay, refresh rotation/family, current scope va IDOR tekshiruvlari serverga tegishli.

SaveAnswer CAS revision va attempt generationga bog‘langan. Submit va bonus idempotency/current auth/transaction bilan himoyalanadi. Bonus bir canonical session+model uchun o‘zgarmas snapshot; Admin activation/replay qilmaydi, successor eski bonusni olmaydi.

OpenAPI origin `https://api.invalid/api/v1` — ishlamaydigan placeholder. Uni haqiqiy endpoint deb clientga yoki providerga sozlamang. Session/TTL/polling/rate-limit va boshqa ochiq qiymatlar hujjatdan taxmin qilinmaydi.


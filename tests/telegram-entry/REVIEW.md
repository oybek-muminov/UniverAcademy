# Atomic Telegram entry candidate

Review code only. Explicit default-off atomic mode now routes entry, retires old Telegram link, and excludes the configured signed Mini App azp subset from old Clerk exchange while retaining other web parties. With the flag absent old behavior remains unchanged. Do not claim the live two-phase flow repaired until approved client reverify/account-choice integration and deployment activate the new mode.

Proposed `POST /api/v1/auth/telegram/entry`:
- Origin must match trusted allowed origin.
- Authorization: Bearer `<Clerk JWT>`.
- Exact JSON: `{ "init_data": "<unaltered Telegram launch proof>", "confirmation": "link-telegram-account-v1" }`.
- No client Telegram ID, person ID, Clerk subject or profile accepted.
- Success200 `{data:{access_token,refresh_token,expires_at,refresh_expires_at,token_type:"Bearer",profile}}`, only after DB commit.
- Responses no-store; origin/validation/token/identity conflict failures do not grant a cabinet.

Client must show the chosen Clerk account, obtain explicit link confirmation, invoke actual Clerk reverification, obtain an uncached JWT, then call the new atomic path directly. Cached Clerk presence alone is not enough. The string is an explicit protocol confirmation, not cryptographic proof of user interaction. The server checks signed fresh fva, both identities and exact existing ownership; it cannot prove that a buggy client rendered the confirmation. Do not auto-call from `isSignedIn`.

Storage reuses `exchangeClerkSession`, `ClerkAuthRows`, existing Telegram HMAC verifier and scoped link function. Clerk advisory → Telegram advisory → mapping → person lock ordering precedes a scoped reload. Existing conflicting Telegram/Clerk ownership fails before creating or issuing a session. New profile, membership, Clerk mapping, family, access/refresh, Telegram link and replay writes commit together. No successful response is emitted for uncertain commit. Launch replay aborts the entire second transaction.

Tests:23 focused assertions and root TypeScript pass. `node tests/telegram-entry/run-native.mjs` passes9 native PostgreSQL17.11 assertions with captured current auth functions, ACLs, roles, RLS, domains, CHECKs and triggers; operations execute as restricted ua_api_login, not superuser. Tests include competing Telegram owners, freeze-vs-entry, completed deletion old-subject barrier and same-Telegram re-registration. This discovered and fixed locator scope order that statement mocks missed. Pending gates: broader native races/graph cases, deployment-time current production ACL/DDL parity, exact provider/frame behavior, browser reverify/account-selection confirmation, no unsafe old-route fallback, expired/lost response resume UX, deletion-tombstone/entry concurrent native tests, contract and provenance integration review. This candidate is not deployed.
